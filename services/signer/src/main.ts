/**
 * Runs the Authorization Signer against Base Sepolia.
 *
 *   pnpm --filter @ntux402/signer run start
 *
 * Reads BASE_SEPOLIA_RPC_URL, POLICY_VAULT_ADDRESS, USDC_ADDRESS, CHAIN_ID and
 * SIGNER_KEY_STORE_PATH. Deliberately does **not** read ORCHESTRATOR_RELAY_KEY:
 * this process has no business submitting transactions, and reading the variable
 * at all is the first step towards doing so.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  bindHost,
  createLogger,
  describeGuard,
  findRepoRoot,
  loadDotEnv,
  required,
  requiredAddress,
} from "@ntux402/shared/node";

import {
  RateLimitedKeyStore,
  describeEnclaveLimits,
  enclaveLimitsFromEnv,
} from "./enclave-limit.js";
import { openKeyStore } from "./keystore.js";
import { createSignerServer } from "./http.js";
import { AuthorizationSigner } from "./service.js";
import { OnChainVaultReader } from "./vault.js";

loadDotEnv();

const log = createLogger("signer");

const port = Number(process.env["SIGNER_PORT"] ?? 8402);
const chainId = Number(process.env["CHAIN_ID"] ?? 84532);

const vault = new OnChainVaultReader({
  rpcUrl: required("BASE_SEPOLIA_RPC_URL"),
  vaultAddress: requiredAddress("POLICY_VAULT_ADDRESS"),
});

/**
 * Where the file key store lives, resolved once and absolutely.
 *
 * `SIGNER_KEY_STORE_PATH` is a relative path by default, and `FileKeyStore`
 * took it verbatim — so it resolved against `process.cwd()`. Start the signer
 * from the repo root instead of `services/signer` and you silently get a
 * *different, empty* store: new payers mint fine, and every payer minted before
 * the move becomes unreachable. Their keys still exist on disk, but nothing
 * looks there any more, and the USDC sitting in those payers can never be swept
 * because sweeping needs the key.
 *
 * That is not hypothetical. Two goals on Base Sepolia hold funds whose payer
 * keys are in a store nothing reads any more.
 *
 * So a relative path is anchored to the repo root, which does not move when the
 * working directory does. An absolute path is honoured as given.
 */
function keyStorePath(): string | undefined {
  const configured = process.env["SIGNER_KEY_STORE_PATH"];
  if (configured === undefined || configured === "") return undefined;
  if (isAbsolute(configured)) return configured;

  const canonical = resolve(findRepoRoot(), configured);

  const legacy = resolve(process.cwd(), configured);
  if (legacy !== canonical && existsSync(legacy)) migrate(legacy, canonical);

  return canonical;
}

/**
 * Moves a legacy key store to the canonical path. A *move*, deliberately.
 *
 * The obvious implementation copies and leaves the original alone, on the
 * reasoning that keeping a spare is the cautious choice. It is not, for key
 * material: the result is two files containing the same private keys, on the
 * same disk, forever. Every copy is somewhere to leak from, somewhere to get
 * swept into an archive, and somewhere to forget. One store was the status quo
 * and one store is what this must leave behind.
 *
 * Safety comes from verifying before deleting rather than from keeping a
 * duplicate. The destination is read back and checked to contain every address
 * the source held; only then is the source removed. If anything about that
 * fails, both files stay and the operator is told — losing a key is
 * unrecoverable, so the fallback is always "keep it and complain".
 */
function migrate(legacy: string, canonical: string): void {
  try {
    if (!existsSync(canonical)) {
      mkdirSync(dirname(canonical), { recursive: true });
      copyFileSync(legacy, canonical);
    }

    // Set explicitly rather than trusting copyFileSync to carry the source
    // mode across. (On Windows this is close to a no-op — NTFS ACLs are the
    // real control there — but the signer is meant to run on Linux.)
    chmodSync(canonical, 0o600);

    const read = (path: string): Record<string, unknown> => {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${path} is not a key store object`);
      }
      return parsed as Record<string, unknown>;
    };

    const source = read(legacy);
    const destination = read(canonical);
    const missing = Object.keys(source).filter(
      (address) => !(address.toLowerCase() in destination) && !(address in destination),
    );
    if (missing.length > 0) {
      throw new Error(
        `${canonical} is missing ${missing.length} key(s) held by ${legacy}`,
      );
    }

    unlinkSync(legacy);
    log.warn("moved the payer key store to a repo-root path", {
      from: legacy,
      to: canonical,
      keys: Object.keys(destination).length,
      why: "a cwd-relative store is unreachable when the signer starts from another directory",
    });
  } catch (e) {
    log.error("could not migrate the payer key store — both files left in place", {
      from: legacy,
      to: canonical,
      detail: e instanceof Error ? e.message : String(e),
      action: "reconcile them by hand; do not delete either until you have",
    });
  }
}

// ROFL when a socket is configured, file/memory otherwise. See keystore.ts for
// why the fallback exists rather than being treated as a misconfiguration.
//
// Read before the store is opened so a malformed limit fails the boot next to
// the other configuration errors, rather than after a socket has been probed.
const enclaveLimits = enclaveLimitsFromEnv();

/*
 * Wrapped, not configured in: the rate limit belongs to the enclave's key
 * daemon rather than to any one store, and applying it out here means the
 * laptop stores get it too. See enclave-limit.ts for why this is separate from
 * the per-IP limiter in http.ts — on the deployed ROFL machine every caller
 * arrives from the Oasis proxy's address, so per-IP cannot tell them apart and
 * this is the bound that actually holds.
 */
const keys = new RateLimitedKeyStore(
  openKeyStore({
    roflSocket: process.env["SIGNER_ROFL_SOCKET"],
    roflIndexPath: process.env["SIGNER_ROFL_INDEX_PATH"],
    filePath: keyStorePath(),
    // Turns a silent downgrade to keys-on-disk into a refusal to boot.
    requireRofl: process.env["SIGNER_REQUIRE_ROFL"] === "true",
  }),
  enclaveLimits,
);

const signer = new AuthorizationSigner({
  vault,
  keys,
  config: { chainId, usdcAddress: requiredAddress("USDC_ADDRESS") },
});

const server = createSignerServer({
  signer,
  log: (line) => log.info(line),
});

server.listen(port, bindHost(), () => {
  const roflSocket = process.env["SIGNER_ROFL_SOCKET"];
  log.info(`listening on http://${bindHost()}:${port}`, { guard: describeGuard() });
  log.info("enclave key operations are rate limited", {
    limits: describeEnclaveLimits(enclaveLimits),
  });
  log.info("bound to chain", { chainId, vault: process.env["POLICY_VAULT_ADDRESS"] });
  log.info("key store", {
    // The resolved absolute path, not the raw setting: which file this is was
    // the ambiguity that lost keys in the first place.
    store: roflSocket
      ? `ROFL enclave via ${roflSocket}`
      : (keyStorePath() ?? "in-memory (keys lost on restart)"),
  });
  // Said plainly, every boot. A local key store is a demo affordance, and the
  // log should not let it pass as a deployment.
  if (!roflSocket) {
    log.warn(
      "no enclave — private keys are held by this process. Set SIGNER_ROFL_SOCKET for real " +
        "custody, and SIGNER_REQUIRE_ROFL=true to make its absence fatal.",
    );
  }
});
