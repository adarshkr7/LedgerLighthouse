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
  loadDotEnv,
  optional,
  optionalAddress,
  required,
  requiredAddress,
  requiredHexKey,
} from "@ntux402/shared/node";
import { Lightning } from "@inco/lightning-js/lite";

import { X402Client } from "./x402/client.js";
import { IncoDecisionReader } from "./inco/reveal.js";
import { PaymentLoop } from "./pay/payment-loop.js";
import { VaultRelay } from "./pay/relay.js";
import { SignerClient } from "./pay/signer-client.js";
import { ScriptedAgent } from "./agent/scripted.js";
import { buildAgent, llmConfigured, probeAgent } from "./agent/factory.js";
import { createOrchestratorServer } from "./server.js";
import { TraceAnchorClient } from "./pay/anchor.js";
import { renderEvent } from "./render.js";
import { assertPayoutAddress, rpcUrls } from "@ntux402/shared";

loadDotEnv();

const log = createLogger("orchestrator");

const port = Number(process.env["ORCHESTRATOR_PORT"] ?? 8404);
const chainId = Number(process.env["CHAIN_ID"] ?? 84532);
const rpcUrl = required("BASE_SEPOLIA_RPC_URL");
const vaultAddress = requiredAddress("POLICY_VAULT_ADDRESS");
const usdcAddress = requiredAddress("USDC_ADDRESS");
const signerUrl = optional("SIGNER_URL") ?? `http://127.0.0.1:${process.env["SIGNER_PORT"] ?? 8402}`;
const mockApiUrl = optional("MOCK_API_URL") ?? `http://127.0.0.1:${process.env["MOCK_API_PORT"] ?? 4021}`;

/*
 * Live search is opt-in, and its absence is a first-class state rather than a
 * broken one. The gate is the *payee*, not the URL: without an address to pay,
 * a goal opened by the console would not allowlist the vendor and every spend
 * would revert with `PayeeNotAllowlisted` — correct, and baffling. Better to
 * report live search as unavailable and let the console grey it out.
 *
 * Note what is deliberately absent: the vendor's API key. This service reads
 * the payee and the URL and nothing else. `scripts/check-boundary.mjs` fails CI
 * if that credential's name appears anywhere in this source tree — including in
 * a comment, which is why this one does not spell it out.
 */
const vendorSearchPayeeRaw = optionalAddress("VENDOR_SEARCH_PAYEE");
const vendorSearchPayee = vendorSearchPayeeRaw
  ? assertPayoutAddress("VENDOR_SEARCH_PAYEE", vendorSearchPayeeRaw)
  : undefined;
const vendorSearchUrl = vendorSearchPayee
  ? (optional("VENDOR_SEARCH_URL") ?? `http://127.0.0.1:${process.env["VENDOR_SEARCH_PORT"] ?? 4022}`)
  : undefined;

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

const zap = await withRetry("Inco Lightning handshake", () =>
  Lightning.baseSepoliaTestnet({ hostChainRpcUrls: [...rpcUrls(rpcUrl)] }),
);

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

const loop = new PaymentLoop({
  client: new X402Client(),
  relay,
  decisions: new IncoDecisionReader(zap),
  signer,
  agent,
  asset: usdcAddress,
  onEvent: (event) => log.info(renderEvent(event)),
});

const server = createOrchestratorServer({
  loop,
  relay,
  vaultAddress,
  usdcAddress,
  chainId,
  mockApiUrl,
  vendorSearchUrl,
  vendorSearchPayee,
  signerUrl,
  signer,
  anchors,
  facilitatorUrl: optional("X402_FACILITATOR_URL"),
  agentSource: agentIsLive ? "llm" : "scripted",
  // Only when it is real. The scripted stand-in has no model name, and the
  // console draws the distinction rather than printing a placeholder.
  ...(agentIsLive && model ? { agentModel: model } : {}),
  traceDir: optional("TRACE_STORE_PATH") ?? ".traces",
  log: (line) => log.info(line),
});

server.listen(port, bindHost(), () => {
  log.info(`listening on http://${bindHost()}:${port}`, { guard: describeGuard() });
  log.info("relay", { address: relay.relayAddress, note: "gas only" });
  log.info("agent", {
    source: agentIsLive ? "live LLM" : "scripted stand-in",
    ...(agentIsLive && model ? { model } : {}),
  });
  log.info("settlement", {
    mode: optional("X402_FACILITATOR_URL") ? "live" : "stub",
  });
  if (!optional("X402_FACILITATOR_URL")) {
    log.warn("settlement is STUBBED — payloads are validated but no money moves");
  }
  log.info("trace anchoring", { contract: anchorAddress ?? "not configured" });
  log.info("live search", {
    vendor: vendorSearchUrl ?? "not configured",
    ...(vendorSearchPayee ? { payee: vendorSearchPayee } : {}),
  });
  if (!vendorSearchPayee) {
    log.warn(
      "live search is unavailable — set VENDOR_SEARCH_PAYEE (and run @ntux402/vendor-search)",
    );
  }

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
