/**
 * Custody of the per-goal ephemeral payer keys.
 *
 * Three properties the rest of the design leans on:
 *
 *  - **Keys are minted before the goal exists.** `goalId` is assigned by the
 *    contract inside `openGoal`, and the payer address is a *field* of that
 *    call — so the store is keyed by address, and the goal record on chain is
 *    what later tells the signer which key to use. There is deliberately no
 *    goalId → key map to get out of step with the chain.
 *  - **A private key never leaves this module.** `mint` returns an address.
 *    `signerFor` returns a viem account, whose `.signTypedData` closes over the
 *    key without exposing it. Nothing returns the key itself, and nothing here
 *    logs one.
 *  - **The interface is async.** Not because the local stores need it, but
 *    because `RoflKeyStore` fetches from an enclave daemon over a socket. Making
 *    the *interface* async is what lets custody move into a TEE without
 *    `AuthorizationSigner` learning where its keys come from.
 *
 * ## Which store to use
 *
 * `RoflKeyStore` is the real one: the key is derived by Oasis ROFL's on-chain
 * key management system and handed only to properly attested enclave instances.
 * `FileKeyStore` and `InMemoryKeyStore` remain because a ROFL socket exists only
 * inside a deployed ROFL container — `pnpm dev` on a laptop has no enclave, and
 * a demo that cannot run offline is a demo that fails at the worst moment.
 *
 * The file store is a hackathon decision, stated openly rather than dressed up:
 * it writes real private keys to disk. That is exactly the `[ASSUMPTION]` the
 * ROFL store exists to retire.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, LocalAccount } from "viem";

/** Serialised form. Addresses are stored lowercased so lookup is unambiguous. */
type StoreFile = Record<string, Hex>;

export interface KeyStore {
  /** Generates a fresh payer key and returns **only** its address. */
  mint(): Promise<Address>;
  /** The signing account for a payer address, or undefined if we hold no key. */
  signerFor(address: Address): Promise<LocalAccount | undefined>;
  /** Addresses we hold keys for. Diagnostics only. */
  addresses(): Promise<readonly Address[]>;
}

export class InMemoryKeyStore implements KeyStore {
  readonly #keys = new Map<string, Hex>();

  async mint(): Promise<Address> {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    this.#keys.set(account.address.toLowerCase(), key);
    return account.address;
  }

  /** Test seam: adopt a known key so a fixture can assert an exact signature. */
  importKey(key: Hex): Address {
    const account = privateKeyToAccount(key);
    this.#keys.set(account.address.toLowerCase(), key);
    return account.address;
  }

  async signerFor(address: Address): Promise<LocalAccount | undefined> {
    const key = this.#keys.get(address.toLowerCase());
    return key === undefined ? undefined : privateKeyToAccount(key);
  }

  async addresses(): Promise<readonly Address[]> {
    return [...this.#keys.values()].map((k) => privateKeyToAccount(k).address);
  }
}

/**
 * JSON file on disk, rewritten on every mint. Created 0600 where the platform
 * honours it — Windows ignores the mode, which is one more reason this is a
 * hackathon store and says so.
 */
export class FileKeyStore implements KeyStore {
  readonly #path: string;
  #cache: StoreFile;

  constructor(path: string) {
    this.#path = path;
    this.#cache = FileKeyStore.#read(path);
  }

  static #read(path: string): StoreFile {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Key store at ${path} is not a JSON object.`);
    }
    return parsed as StoreFile;
  }

  #write(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, `${JSON.stringify(this.#cache, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(this.#path, 0o600);
    } catch {
      /* Windows has no POSIX mode; the write above already used it where it counts. */
    }
  }

  async mint(): Promise<Address> {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    this.#cache[account.address.toLowerCase()] = key;
    this.#write();
    return account.address;
  }

  async signerFor(address: Address): Promise<LocalAccount | undefined> {
    const key = this.#cache[address.toLowerCase()];
    return key === undefined ? undefined : privateKeyToAccount(key);
  }

  async addresses(): Promise<readonly Address[]> {
    return Object.values(this.#cache).map((k) => privateKeyToAccount(k).address);
  }
}

// --------------------------------------------------------------------- ROFL

/**
 * The one capability we need from `rofl-appd`. An interface, so the store is
 * testable without an enclave — the same reason `DecisionReader` exists on the
 * Inco side.
 */
export interface RoflAppd {
  /**
   * Derives a key for `keyId`. Deterministic: the same `keyId` in the same app
   * yields the same key, across restarts and redeployments.
   */
  generateKey(keyId: string): Promise<Hex>;
}

/** Documented default. Bind-mounted into the container from the host. */
export const ROFL_APPD_SOCKET = "/run/rofl-appd.sock";

/**
 * `rofl-appd` over its UNIX domain socket.
 *
 * Deliberately raw `node:http` against the documented endpoint rather than
 * `@oasisprotocol/rofl-client`: the surface we use is one POST, the socket path
 * and payload are documented verbatim, and the SDK would pull the whole
 * consensus-layer client in for it. `node:http` speaks UDS natively via
 * `socketPath`, so this costs no dependency at all.
 *
 *   POST /rofl/v1/keys/generate  {"key_id": "...", "kind": "secp256k1"}
 *                             -> {"key": "<hex, no 0x prefix>"}
 *
 * The socket exists only inside a ROFL container, and appd only answers for
 * properly attested app instances. That is the whole security property: this
 * code cannot obtain a key anywhere else, and neither can anything outside the
 * enclave.
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
              `inside a deployed ROFL container; use SIGNER_KEY_STORE_PATH for local runs.`,
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
 * asserted rather than assumed — a short key would otherwise silently derive a
 * valid-looking but wrong address, and the first sign of that would be a
 * settlement failing against an address nobody funded.
 */
export function normalizePrivateKey(key: string): Hex {
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`rofl-appd returned a ${hex.length}-char key; expected 64 hex chars.`);
  }
  return `0x${hex}`;
}

/**
 * Payer keys derived inside an Oasis ROFL enclave.
 *
 * ## What changes, and what does not
 *
 * `AuthorizationSigner` is untouched. Every refusal in `service.ts` still
 * applies; the signer still accepts only `(goalId, seq)` and still reads every
 * signed field from the chain. The only difference is where the key came from.
 *
 * ## Why the index is not a secret
 *
 * ROFL derivation is deterministic on `key_id`, so this store persists only
 * `address -> key_id` and re-derives the key on demand. That file contains no
 * key material — the meaningful difference from `FileKeyStore`, which writes
 * private keys to disk. Lose the index and the keys become unreachable, which is
 * a recoverability tradeoff worth stating: it is the price of never writing a
 * secret down.
 *
 * ## What this does and does not prove
 *
 * It proves custody: the key exists only inside an attested enclave, and no
 * operator — including whoever runs the container — can extract it. It does not
 * prove that fact *to Base*, which cannot verify Oasis attestations. Binding the
 * payer address to the app's enclave identity in a way a third party can check
 * requires publishing that binding on Sapphire, which is deliberately out of
 * scope here.
 */
export class RoflKeyStore implements KeyStore {
  readonly #appd: RoflAppd;
  readonly #indexPath: string | undefined;
  /** address (lowercased) -> key_id. No secrets. */
  #index: Record<string, string>;

  constructor(appd: RoflAppd, indexPath?: string) {
    this.#appd = appd;
    this.#indexPath = indexPath;
    this.#index = indexPath !== undefined && existsSync(indexPath)
      ? (JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, string>)
      : {};
  }

  #persist(): void {
    if (this.#indexPath === undefined) return;
    mkdirSync(dirname(this.#indexPath), { recursive: true });
    writeFileSync(this.#indexPath, `${JSON.stringify(this.#index, null, 2)}\n`);
  }

  async mint(): Promise<Address> {
    // Random rather than a counter: a counter would have to be persisted before
    // the key it names, and a crash between the two would hand out a key_id the
    // next mint reuses.
    const keyId = `payer/${randomUUID()}`;
    const key = await this.#appd.generateKey(keyId);
    const account = privateKeyToAccount(key);
    this.#index[account.address.toLowerCase()] = keyId;
    this.#persist();
    return account.address;
  }

  async signerFor(address: Address): Promise<LocalAccount | undefined> {
    const keyId = this.#index[address.toLowerCase()];
    if (keyId === undefined) return undefined;
    // Re-derived per signature rather than cached, so the process holds key
    // material for as short a time as it can.
    return privateKeyToAccount(await this.#appd.generateKey(keyId));
  }

  async addresses(): Promise<readonly Address[]> {
    return Object.keys(this.#index) as Address[];
  }
}

/**
 * Chooses a store from the environment.
 *
 * ROFL wins when `SIGNER_ROFL_SOCKET` is set, because asking for enclave custody
 * and silently getting a file instead is the failure mode worth designing out.
 * If the socket is named but absent, `mint` throws with a message that says so —
 * better than a demo that appears to work while writing keys to disk.
 */
export function openKeyStore(options: {
  roflSocket?: string | undefined;
  roflIndexPath?: string | undefined;
  filePath?: string | undefined;
}): KeyStore {
  if (options.roflSocket !== undefined && options.roflSocket !== "") {
    return new RoflKeyStore(new SocketRoflAppd(options.roflSocket), options.roflIndexPath);
  }
  return options.filePath === undefined || options.filePath === ""
    ? new InMemoryKeyStore()
    : new FileKeyStore(options.filePath);
}
