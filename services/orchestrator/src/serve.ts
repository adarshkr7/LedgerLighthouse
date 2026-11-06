/**
 * Runs the orchestrator as a service for the web UI.
 *
 *   pnpm --filter @ntux402/orchestrator run serve
 *
 * Holds the relay key. Never the payer key — that lives in the signer, and the
 * boundary check exists to keep it that way.
 */

import {
  bindHost,
  createLogger,
  describeGuard,
  exposedWithoutToken,
  loadDotEnv,
  networkFromEnv,
  optional,
  optionalAddress,
  requiredAddress,
  requiredHexKey,
} from "@ntux402/shared/node";
import type { Hex } from "viem";

import { X402Client } from "./x402/client.js";
import { IncoDecisionReader } from "./inco/reveal.js";
import { IncoHealthProbe } from "./inco/health.js";
import { connectLightning } from "./inco/lightning.js";
import { PaymentLoop } from "./pay/payment-loop.js";
import { VaultRelay } from "./pay/relay.js";
import { SignerClient } from "./pay/signer-client.js";
import { ScriptedAgent } from "./agent/scripted.js";
import { buildAgent, llmConfigured, probeAgent } from "./agent/factory.js";
import { createOrchestratorServer } from "./server.js";
import { TraceAnchorClient } from "./pay/anchor.js";
import { renderEvent } from "./render.js";

loadDotEnv();

const log = createLogger("orchestrator");

const port = Number(process.env["ORCHESTRATOR_PORT"] ?? 8404);
const { network, rpcUrl, usdcAddress } = networkFromEnv();
const chainId = network.chainId;
const vaultAddress = requiredAddress("POLICY_VAULT_ADDRESS");
const signerUrl = optional("SIGNER_URL") ?? `http://127.0.0.1:${process.env["SIGNER_PORT"] ?? 8402}`;
const mockApiUrl = optional("MOCK_API_URL") ?? `http://127.0.0.1:${process.env["MOCK_API_PORT"] ?? 4021}`;

/*
 * Anchoring is opt-in on the address being set. Absent, traces stay
 * tamper-evident but carry no proof of when they said it — see pay/anchor.ts.
 */
const anchorAddress = optionalAddress("TRACE_ANCHOR_ADDRESS");
const anchors = anchorAddress
  ? new TraceAnchorClient({
      rpcUrl,
      anchorAddress,
      // The same gas-only relay key. Anchoring authorizes no payment.
      relayKey: requiredHexKey("ORCHESTRATOR_RELAY_KEY"),
      chainId,
    })
  : undefined;

const relay = new VaultRelay({
  rpcUrl,
  vaultAddress,
  relayKey: requiredHexKey("ORCHESTRATOR_RELAY_KEY"),
  chainId,
});

/**
 * Retries an operation that depends on a flaky upstream, with linear backoff.
 *
 * Unlike the facilitator's gas read, the Lightning client genuinely is a
 * precondition here — the orchestrator cannot evaluate a confidential policy
 * without it, so serving without one would just move the failure to the first
 * request. But "cannot start" and "could not start on the first attempt" are
 * very different things, and a top-level `await` with no retry conflated them:
 * one unhealthy response from the public RPC killed the process, and the demo
 * came up missing its orchestrator for a reason nothing on screen explained.
 *
 * Bounded rather than infinite, so a genuinely wrong RPC URL still fails and
 * says so instead of hanging forever in a retry loop.
 */
async function withRetry<T>(what: string, attempt: () => Promise<T>): Promise<T> {
  const tries = 5;
  for (let n = 1; ; n += 1) {
    try {
      return await attempt();
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
      if (n >= tries) {
        log.error(`${what} failed after ${tries} attempts`, { detail });
        throw error;
      }
      const wait = n * 2000;
      log.warn(`${what} failed, retrying`, { attempt: `${n}/${tries}`, waitMs: wait, detail });
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

const zap = await withRetry("Inco Lightning handshake", () => connectLightning(network, rpcUrl));

const apiKey = optional("LLM_API_KEY");
const model = optional("LLM_MODEL");
const baseUrl = optional("LLM_BASE_URL");
/*
 * All three, not just the key — `buildAgent` needs a key, a model id and a
 * gateway to return a live model, so reporting on the key alone would announce
 * "live LLM" for a run that is about to be decided by the scripted stand-in.
 */
const agentIsLive = llmConfigured({ apiKey, model, baseUrl });
const agent = await buildAgent({
  apiKey,
  model,
  baseUrl,
  fallback: new ScriptedAgent(),
  onFallback: (detail) =>
    log.warn("model gateway did not answer — scripted stand-in decided this call", { detail }),
});

/*
 * Outbound credential, deliberately its own variable.
 *
 * `SERVICE_TOKEN` means "require a bearer on *my* mutating routes" — see
 * `authorized()` in @ntux402/shared. Reusing it here overloaded one variable
 * with two opposite jobs, and setting it to reach a ROFL signer silently armed
 * the orchestrator's own guard as well. The browser holds no token, so the
 * console locked itself out of /runs and /payer the moment the signer moved
 * into the enclave.
 *
 * `SIGNER_SERVICE_TOKEN` is what this service *presents*; `SERVICE_TOKEN` stays
 * what it *demands*. The fallback keeps a mesh deployment working where every
 * service shares one token and the browser is behind the same gateway.
 */
const signer = new SignerClient(
  signerUrl,
  undefined,
  optional("SIGNER_SERVICE_TOKEN") ?? optional("SERVICE_TOKEN"),
);

const decisions = new IncoDecisionReader(zap);

/*
 * The probe needs a decision that is already revealed on this network. A
 * network nobody has run on yet has none, and refusing every run until one
 * exists would make the first run impossible. So the probe is skipped and
 * /health/inco says "unchecked", which the console shows as such.
 * INCO_PROBE_HANDLE fills the gap once a first run has produced a handle.
 */
const probeHandle = (optional("INCO_PROBE_HANDLE") as Hex | undefined) ?? network.incoProbeHandle;
const incoHealth = probeHandle ? new IncoHealthProbe(decisions, { handle: probeHandle }) : undefined;

const loop = new PaymentLoop({
  client: new X402Client(),
  relay,
  decisions,
  signer,
  agent,
  asset: usdcAddress,
  escrow: { vault: vaultAddress, network: `eip155:${chainId}` },
  onEvent: (event) => log.info(renderEvent(event)),
});

const server = createOrchestratorServer({
  loop,
  relay,
  vaultAddress,
  usdcAddress,
  chainId,
  mockApiUrl,
  incoHealth,
  signerUrl,
  signer,
  anchors,
  agentSource: agentIsLive ? "llm" : "scripted",
  // Only when it is real. The scripted stand-in has no model name, and the
  // console draws the distinction rather than printing a placeholder.
  ...(agentIsLive && model ? { agentModel: model } : {}),
  traceDir: optional("TRACE_STORE_PATH") ?? ".traces",
  log: (line) => log.info(line),
});

server.listen(port, bindHost(), () => {
  log.info(`listening on http://${bindHost()}:${port}`, { guard: describeGuard() });
  // In the terminal at boot, where it is cheapest to act on: minutes before a
  // demo rather than in the middle of one.
  log.info("network", { name: network.label, chainId, vault: vaultAddress });
  if (!network.testnet) log.warn(`${network.label} is mainnet: USDC and gas here are real money`);
  if (incoHealth) {
    void incoHealth.check().then((inco) => {
      if (inco.status === "ready") log.info("inco", { status: "ready", latencyMs: inco.latencyMs });
      else log.warn(`inco is UNAVAILABLE, runs will be refused until it recovers: ${inco.detail}`);
    });
  } else {
    log.warn(
      `inco is UNCHECKED: no revealed decision is known on ${network.label} to probe with. ` +
        "Runs are allowed but may stall at the confidential evaluation. Set INCO_PROBE_HANDLE " +
        "to a revealed decision handle once one exists.",
    );
  }
  /*
   * Said at boot rather than discovered at the download button. The trace route
   * refuses in this combination, and an operator who bound the service outward
   * on purpose should hear about the consequence while they are still looking
   * at the terminal.
   */
  if (exposedWithoutToken()) {
    log.warn(
      "bound to the network with no SERVICE_TOKEN — GET /traces/:goalId will refuse. " +
        "Traces are run records; set a token, or bind loopback and fetch them from this machine.",
    );
  }
  log.info("relay", { address: relay.relayAddress, note: "gas only" });
  log.info("agent", {
    source: agentIsLive ? "live LLM" : "scripted stand-in",
    ...(agentIsLive && model ? { model } : {}),
  });
  log.info("trace anchoring", { contract: anchorAddress ?? "not configured" });

  /*
   * Fire-and-forget on purpose. The answer changes nothing about how the server
   * behaves — `FallbackAgent` already handles a dead gateway per call — so
   * making startup wait on a network round trip would buy a slower boot and no
   * extra safety. What it buys is finding out now, in the log, rather than from
   * a reasoning panel that says MODEL UNAVAILABLE in front of an audience.
   */
  void probeAgent({ apiKey, model, baseUrl }).then((probe) => {
    if (!probe) return;
    if (probe.ok) log.info("agent gateway reachable", { detail: probe.detail });
    else
      log.warn("agent gateway did NOT answer — runs will use the scripted stand-in", {
        model: model ?? "unset",
        detail: probe.detail,
      });
  });
});
