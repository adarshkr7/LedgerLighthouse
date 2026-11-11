/**
 * Custody of the payer keys and the enrollment key.
 *
 * ## Every key is derived, and a payer key is derived for one owner
 *
 * A payer key's id is `payer/<chainId>/<vault>/<owner>/<enrollmentId>`. The
 * owner's wallet chooses the enrollment id (the console draws 32 random bytes),
 * and the vault records it at `openEnrolledGoal`. Three things follow.
 *
 *  - **No statement for a payer can name another owner.** The payer address is a
 *    function of the owner, so the signer cannot be asked to enroll one payer
 *    to two wallets, by a hostile orchestrator or by a restart that forgot what
 *    it had issued. The enrollment statement (`escrow-service.ts`) relies on it.
 *  - **Nothing needs to be remembered.** The goal record on chain names the owner
 *    and the vault names the enrollment id, so the signer derives the key it
 *    needs when it needs it. There is no index to lose with a machine's disk,
 *    and no counter to rebuild. The version before this counted ids and
 *    rebuilt the count from the chain after a wipe, which needed gaps between
 *    bound ids to stay short; anyone could widen a gap by calling the
 *    unauthenticated mint route.
 *  - **A private key never leaves this module.** Both methods return a viem
 *    account, whose `signTypedData` closes over the key.
 *
 * The enrollment key's id is `enrollment/<chainId>`. It does not name the vault,
 * so its address can be read before the vault that pins it is deployed. The
 * statement's EIP-712 domain names the vault instead.
 *
 * ## Where the keys come from
 *
 * `rofl-appd` in a deployed ROFL machine: Oasis's key manager derives a key from
 * the app's identity and the id, and hands it only to instances the app's
 * on-chain policy admits, which is where the accepted enclave measurements are
 * listed. So the enrollment key, and through it every enrollment statement, is
 * tied to those measurements: a valid statement was produced by an admitted
 * instance, or the key manager is broken.
 *
 * On a laptop there is no appd, so a seed stands in, held in a file or in memory.
 * Such a seed is a private key on disk, and a statement signed with it ties the
 * payer to nothing but whoever holds that file. That is what local runs mean.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { request as httpRequest } from "node:http";

import { concat, hexToBigInt, keccak256, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface KeyStore {
  /** The payer key enrolled for `owner` under `enrollmentId`. Deterministic. */
  payer(owner: Address, enrollmentId: Hex): Promise<LocalAccount>;
  /** The key that signs enrollment statements. */
  enrollment(): Promise<LocalAccount>;
  /** Where the keys come from, for /health. */
  readonly kind: "rofl" | "file" | "memory";
}

/**
 * The one capability we need from `rofl-appd`. An interface, so the store is
 * testable without an enclave.
 */
export interface RoflAppd {
  /**
   * Derives a key for `keyId`. Deterministic: the same `keyId` in the same app
   * yields the same key, across restarts and redeployments.
   */
  generateKey(keyId: string): Promise<Hex>;
}

/** Scopes payer keys to one chain and one vault. */
export interface KeyNamespace {
  readonly chainId: number;
  readonly vault: Address;
}

export function payerKeyId(ns: KeyNamespace, owner: Address, enrollmentId: Hex): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(enrollmentId)) {
    throw new Error(`enrollment id must be 32 bytes of hex, got ${enrollmentId}`);
  }
  return `payer/${ns.chainId}/${ns.vault.toLowerCase()}/${owner.toLowerCase()}/${enrollmentId.toLowerCase()}`;
}

export function enrollmentKeyId(chainId: number): string {
  return `enrollment/${chainId}`;
}

/** Derives every key from one source, under the ids above. */
export class DerivedKeyStore implements KeyStore {
  readonly #source: RoflAppd;
  readonly #ns: KeyNamespace;
  readonly kind: "rofl" | "file" | "memory";

  constructor(source: RoflAppd, ns: KeyNamespace, kind: "rofl" | "file" | "memory") {
    this.#source = source;
    this.#ns = ns;
    this.kind = kind;
  }

  async payer(owner: Address, enrollmentId: Hex): Promise<LocalAccount> {
    // Re-derived per call and not cached, so the process holds key material for
    // as short a time as it can.
    return privateKeyToAccount(await this.#source.generateKey(payerKeyId(this.#ns, owner, enrollmentId)));
  }

  async enrollment(): Promise<LocalAccount> {
    return privateKeyToAccount(await this.#source.generateKey(enrollmentKeyId(this.#ns.chainId)));
  }
}

// ---------------------------------------------------------------- local seed

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Stands in for appd on a laptop: keccak256(seed || keyId), re-hashed in the
 * negligible case that the result is not a valid secp256k1 scalar.
 */
export class SeedKeySource implements RoflAppd {
  readonly #seed: Hex;

  constructor(seed: Hex) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(seed)) throw new Error("the seed must be 32 bytes of hex");
    this.#seed = seed;
  }

  async generateKey(keyId: string): Promise<Hex> {
    let key = keccak256(concat([this.#seed, toHex(keyId)]));
    while (hexToBigInt(key) === 0n || hexToBigInt(key) >= SECP256K1_N) key = keccak256(key);
    return key;
  }
}

/** A fresh seed each start: every key is lost on restart. Tests and throwaway runs. */
export function inMemoryKeyStore(ns: KeyNamespace, seed: Hex = generatePrivateKey()): DerivedKeyStore {
  return new DerivedKeyStore(new SeedKeySource(seed), ns, "memory");
}

/**
 * The seed in a JSON file, `{ "seed": "0x…" }`, created 0600 where the platform
 * honours it. The file is the private key of every payer this signer will ever
 * enroll on a laptop, so it is treated as one.
 */
export function fileKeyStore(path: string, ns: KeyNamespace): DerivedKeyStore {
  let seed: Hex;
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const value = (parsed as { seed?: unknown } | null)?.seed;
    if (typeof value !== "string") {
      throw new Error(
        `${path} is not a seed file. The format before enrollment was an address-to-key map; ` +
          `keep that file for the old vault's payers and point SIGNER_SEED_PATH at a new one.`,
      );
    }
    seed = value as Hex;
  } else {
    seed = generatePrivateKey();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ seed }, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows has no POSIX mode. */
    }
  }
  return new DerivedKeyStore(new SeedKeySource(seed), ns, "file");
}

// --------------------------------------------------------------------- ROFL

/** Documented default. Bind-mounted into the container from the host. */
export const ROFL_APPD_SOCKET = "/run/rofl-appd.sock";

/**
 * `rofl-appd` over its UNIX domain socket.
 *
 *   POST /rofl/v1/keys/generate  {"key_id": "...", "kind": "secp256k1"}
 *                             -> {"key": "<hex, no 0x prefix>"}
 *
 * Raw `node:http` against the documented endpoint: the surface we use is one
 * POST, and the SDK would pull the whole consensus-layer client in for it.
 */
export class SocketRoflAppd implements RoflAppd {
  readonly #socketPath: string;

  constructor(socketPath: string = ROFL_APPD_SOCKET) {
    this.#socketPath = socketPath;
  }

  async generateKey(keyId: string): Promise<Hex> {
    const body = JSON.stringify({ key_id: keyId, kind: "secp256k1" });

    const raw = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.#socketPath,
          path: "/rofl/v1/keys/generate",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== 200) {
              reject(new Error(`rofl-appd returned ${res.statusCode}: ${text}`));
              return;
            }
            resolve(text);
          });
        },
      );
      req.on("error", (e) =>
        reject(
          new Error(
            `rofl-appd unreachable at ${this.#socketPath}: ${e.message}. This store only works ` +
              `inside a deployed ROFL container; use SIGNER_SEED_PATH for local runs.`,
          ),
        ),
      );
      req.end(body);
    });

    const parsed: unknown = JSON.parse(raw);
    const key = (parsed as { key?: unknown }).key;
    if (typeof key !== "string") {
      throw new Error(`rofl-appd response has no string "key" field: ${raw}`);
    }
    return normalizePrivateKey(key);
  }
}

/**
 * appd returns the key unprefixed (`"a54027bf…"`), viem requires `0x`. Length is
 * asserted rather than assumed: a short key would derive a valid-looking but
 * wrong address.
 */
export function normalizePrivateKey(key: string): Hex {
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`rofl-appd returned a ${hex.length}-char key; expected 64 hex chars.`);
  }
  return `0x${hex}`;
}

/**
 * Chooses a store from the environment.
 *
 * ROFL wins when `SIGNER_ROFL_SOCKET` is set, because asking for enclave custody
 * and silently getting a file instead is the failure worth designing out. With
 * `requireRofl`, a missing socket is a refusal to boot.
 */
export function openKeyStore(options: {
  ns: KeyNamespace;
  roflSocket?: string | undefined;
  seedPath?: string | undefined;
  requireRofl?: boolean | undefined;
}): KeyStore {
  const socket = options.roflSocket;
  if (socket !== undefined && socket !== "") {
    return new DerivedKeyStore(new SocketRoflAppd(socket), options.ns, "rofl");
  }
  if (options.requireRofl === true) {
    throw new Error(
      "SIGNER_REQUIRE_ROFL is set but SIGNER_ROFL_SOCKET is empty. Refusing to start: the " +
        "fallback stores hold a seed in the process or on disk, which is exactly what " +
        "requiring ROFL is meant to prevent.",
    );
  }
  return options.seedPath === undefined || options.seedPath === ""
    ? inMemoryKeyStore(options.ns)
    : fileKeyStore(options.seedPath, options.ns);
}

/** For tests: a stable 32-byte id from a label. */
export function enrollmentIdFrom(label: string): Hex {
  return keccak256(toHex(label));
}
