/**
 * Runs the Authorization Signer against the network NETWORK names (Base
 * Sepolia when unset).
 *
 *   pnpm --filter @ntux402/signer run start
 *
 * Reads NETWORK, RPC_URL (or BASE_SEPOLIA_RPC_URL), POLICY_VAULT_ADDRESS and
 * SIGNER_SEED_PATH (or SIGNER_ROFL_SOCKET inside an enclave). CHAIN_ID and USDC_ADDRESS are still accepted, as
 * checks against NETWORK. Deliberately does **not** read ORCHESTRATOR_RELAY_KEY:
 * this process has no business submitting transactions, and reading the variable
 * at all is the first step towards doing so.
 */

import type { Server } from "node:http";
import { isAbsolute, resolve } from "node:path";

import {
  bindHost,
  createLogger,
  describeGuard,
  findRepoRoot,
  loadDotEnv,
  networkFromEnv,
  requiredAddress,
} from "@ntux402/shared/node";

import {
  RateLimitedKeyStore,
  describeEnclaveLimits,
  enclaveLimitsFromEnv,
} from "./enclave-limit.js";
import { openKeyStore } from "./keystore.js";
import { createBootFailureServer, createSignerServer, type BootFailure } from "./http.js";
import { openSigner } from "./open-signer.js";
import { OnChainVaultReader } from "./vault.js";
import { hintFor, summarize } from "./boot-failure.js";

loadDotEnv();

const log = createLogger("signer");

const port = Number(process.env["SIGNER_PORT"] ?? 8402);

/**
 * Where the local seed lives, resolved once and absolutely. A relative path is
 * anchored to the repo root, which does not move when the working directory
 * does: a cwd-relative key file once left payers unreachable after the signer
 * was started from another directory.
 */
function seedPath(): string | undefined {
  const configured = process.env["SIGNER_SEED_PATH"];
  if (configured === undefined || configured === "") return undefined;
  return isAbsolute(configured) ? configured : resolve(findRepoRoot(), configured);
}

// ------------------------------------------------------------------- boot

/**
 * Everything that can stop the signer from starting, in order, with the step
 * named before each so a failure can say where it happened.
 */
async function boot(step: (name: string) => void) {
  step("configuration");
  const { network, rpcUrl, usdcAddress } = networkFromEnv();
  const chainId = network.chainId;
  const vaultAddress = requiredAddress("POLICY_VAULT_ADDRESS");
  // Read before the store is opened so a malformed limit fails next to the
  // other configuration errors, rather than after a socket has been probed.
  const enclaveLimits = enclaveLimitsFromEnv();
  const vault = new OnChainVaultReader({ rpcUrl, vaultAddress, chainId });

  // ROFL when a socket is configured, a seed file or memory otherwise.
  step("key store");
  const store = openKeyStore({
    ns: { chainId, vault: vaultAddress },
    roflSocket: process.env["SIGNER_ROFL_SOCKET"],
    seedPath: seedPath(),
    // Turns a silent downgrade to keys-on-disk into a refusal to boot.
    requireRofl: process.env["SIGNER_REQUIRE_ROFL"] === "true",
  });

  // Derived before anything that can fail on the vault, so a boot failure can
  // still report it: deploying a vault needs this address first.
  step("enrollment key");
  enrollmentAddress = (await store.enrollment()).address;

  /*
   * Wrapped, not configured in: the rate limit belongs to the enclave's key
   * daemon rather than to any one store. See enclave-limit.ts.
   */
  const keys = new RateLimitedKeyStore(store, enclaveLimits);
  step("settlement binding");
  const signer = await openSigner({ vault, keys, chainId, usdcAddress, vaultAddress });
  const server = createSignerServer({
    signer,
    binding: { chainId, vault: vaultAddress, settlement: "escrow" },
    custody: async () => ({ store: store.kind, enrollmentSigner: enrollmentAddress ?? "" }),
    log: (line) => log.info(line),
  });

  const describe = () => {
    const roflSocket = process.env["SIGNER_ROFL_SOCKET"];
    log.info(`listening on http://${bindHost()}:${port}`, { guard: describeGuard() });
    log.info("enclave key operations are rate limited", {
      limits: describeEnclaveLimits(enclaveLimits),
    });
    log.info("bound to chain", { network: network.label, chainId, vault: vaultAddress, settlement: "escrow" });
    if (!network.testnet) log.warn(`${network.label} is mainnet: the payers this signer holds carry real USDC`);
    log.info("key store", {
      store: roflSocket ? `ROFL enclave via ${roflSocket}` : (seedPath() ?? "in-memory seed (keys lost on restart)"),
      enrollmentSigner: enrollmentAddress,
    });
    // Said plainly, every boot. A local key store is a demo affordance, and
    // the log should not let it pass as a deployment.
    if (!roflSocket) {
      log.warn(
        "no enclave — private keys are held by this process. Set SIGNER_ROFL_SOCKET for real " +
          "custody, and SIGNER_REQUIRE_ROFL=true to make its absence fatal.",
      );
    }
  };

  return { server, describe };
}

/*
 * Boot, and if it fails, stay up and say why rather than exit. A crash loop
 * inside a ROFL machine shows nothing but "connection refused" from outside;
 * this way GET /health names the step and the error. Boot is retried every 30
 * seconds, so a passing cause, such as the RPC being down when the machine
 * came up, clears without anyone intervening.
 */
let failure: BootFailure | undefined;
/** Set by boot once the key store is open; reported even when a later step fails. */
let enrollmentAddress: string | undefined;
let failureServer: Server | undefined;
for (let attempt = 1; ; attempt++) {
  let stage = "start";
  try {
    const ready = await boot((name) => (stage = name));
    if (failureServer) {
      const closing = failureServer;
      await new Promise<void>((resolve) => {
        closing.close(() => resolve());
        closing.closeAllConnections();
      });
      log.info("boot succeeded after failing; serving normally", { attempts: attempt });
    }
    ready.server.listen(port, bindHost(), ready.describe);
    break;
  } catch (error) {
    const detail = summarize(error);
    failure = {
      stage,
      detail,
      hint: hintFor(stage, detail),
      ...(enrollmentAddress ? { enrollmentSigner: enrollmentAddress } : {}),
      since: failure?.since ?? new Date().toISOString(),
      attempts: attempt,
    };
    log.error(`boot failed at ${stage}; /health reports why, retrying in 30s`, {
      detail,
      ...(failure.hint ? { hint: failure.hint } : {}),
      attempt,
    });
    if (!failureServer) {
      failureServer = createBootFailureServer(() => failure!);
      failureServer.listen(port, bindHost());
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}
