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
 * ## Key ids are counted, so a lost index can be rebuilt
 *
 * ROFL derivation is deterministic on `key_id` within one app, across machines
 * and redeployments. This store used to name keys `payer/<random uuid>` and keep
 * the only copy of each id in an index on the machine's disk. When the rented
 * machine expired its disk went with it, and every payer it had minted became
 * unreachable: by 9 October 2026 that was 9.82 test USDC in 30 payers on Base
 * Sepolia, still derivable by the enclave, under ids nobody knew.
 *
 * Ids are now `payer/<namespace>/<n>`, where the namespace is the chain and the
 * vault and `n` counts up. The index is a cache. When it has no record of the
 * namespace, `recover()` re-derives `payer/<namespace>/0`, `/1`, … and keeps
 * every address the vault reports as bound to a goal, until a run of unbound
 * ids says it is past the last one. A payer that matters is a payer with a goal,
 * and the payer binding means each has exactly one, so the chain is enough to
 * rebuild everything worth rebuilding.
 *
 * `mint` advances the counter and persists it *before* deriving, so a crash can
 * skip an id but never hand one out twice. After a rebuild the counter resumes
 * past the scanned window, so an id minted but not yet bound when the index was
 * lost is not reissued either. And if one ever were, the vault refuses to bind a
 * payer to a second goal.
 *
 * Ids minted under the old random scheme are kept when an old index is loaded,
 * but cannot be rebuilt if it is lost.
 *
 * ## Why the index is not a secret
 *
 * It maps addresses to key ids. No key material is written anywhere, which is
 * the meaningful difference from `FileKeyStore`. A key id is useless outside
 * the app's attested enclave, because only that enclave can derive from it.
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
  readonly #namespace: string;
  /** address (lowercased) -> key_id. No secrets. */
  #keys: Record<string, string>;
  /** namespace -> next n to mint. Absent means this index has no record of it. */
  #next: Record<string, number>;

  /**
   * @param namespace scopes key ids to one chain and vault, e.g.
   *   `84532/0x518b…522c`. Goal ids and payer bindings do not carry across
   *   vaults, so neither does the counter.
   */
  constructor(appd: RoflAppd, indexPath?: string, namespace = "default") {
    this.#appd = appd;
    this.#indexPath = indexPath;
    this.#namespace = namespace;
    const loaded =
      indexPath !== undefined && existsSync(indexPath)
        ? (JSON.parse(readFileSync(indexPath, "utf8")) as unknown)
        : undefined;
    if (isIndexV2(loaded)) {
      this.#keys = { ...loaded.keys };
      this.#next = { ...loaded.next };
    } else {
      // The original format: a bare address -> key_id map, random ids only.
      this.#keys = (loaded as Record<string, string> | undefined) ?? {};
      this.#next = {};
    }
  }

  #persist(): void {
    if (this.#indexPath === undefined) return;
    mkdirSync(dirname(this.#indexPath), { recursive: true });
    const file: IndexV2 = { version: 2, next: this.#next, keys: this.#keys };
    writeFileSync(this.#indexPath, `${JSON.stringify(file, null, 2)}\n`);
  }

  #keyId(n: number): string {
    return `payer/${this.#namespace}/${n}`;
  }

  async #addressOf(keyId: string): Promise<Address> {
    return privateKeyToAccount(await this.#appd.generateKey(keyId)).address;
  }

  /**
   * Rebuilds this namespace's part of the index from the chain, when the index
   * has no record of it. Call once at boot, before serving.
   *
   * @param isBound whether an address is the payer of a goal on this vault.
   *   It must throw rather than answer false when it cannot tell: a wrong
   *   "unbound" ends the scan early and leaves later payers out.
   * @param gap consecutive unbound ids that end the scan.
   * @returns undefined when the index already knew the namespace.
   */
  async recover(
    isBound: (address: Address) => Promise<boolean>,
    gap = 25,
  ): Promise<{ readonly scanned: number; readonly found: number } | undefined> {
    if (this.#next[this.#namespace] !== undefined) return undefined;

    let n = 0;
    let found = 0;
    for (let misses = 0; misses < gap; n++) {
      const keyId = this.#keyId(n);
      const address = await this.#addressOf(keyId);
      if (await isBound(address)) {
        this.#keys[address.toLowerCase()] = keyId;
        found++;
        misses = 0;
      } else {
        misses++;
      }
    }

    // Past the whole scanned window, not just past the last bound id: an id
    // minted but not yet bound when the index was lost is not handed out again.
    this.#next[this.#namespace] = n;
    this.#persist();
    return { scanned: n, found };
  }

  async mint(): Promise<Address> {
    // Advanced and persisted before deriving: a crash between the two skips n
    // rather than reusing it. Synchronous up to the persist, so two concurrent
    // mints cannot read the same n.
    const n = this.#next[this.#namespace] ?? 0;
    this.#next[this.#namespace] = n + 1;
    this.#persist();

    const keyId = this.#keyId(n);
    const address = await this.#addressOf(keyId);
    this.#keys[address.toLowerCase()] = keyId;
    this.#persist();
    return address;
  }

  async signerFor(address: Address): Promise<LocalAccount | undefined> {
    const keyId = this.#keys[address.toLowerCase()];
    if (keyId === undefined) return undefined;
    // Re-derived per signature rather than cached, so the process holds key
    // material for as short a time as it can.
    return privateKeyToAccount(await this.#appd.generateKey(keyId));
  }

  async addresses(): Promise<readonly Address[]> {
    return Object.keys(this.#keys) as Address[];
  }
}

/** The index as written since key ids became counted. */
interface IndexV2 {
  readonly version: 2;
  readonly next: Record<string, number>;
  readonly keys: Record<string, string>;
}

function isIndexV2(value: unknown): value is IndexV2 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 2 &&
    typeof (value as { next?: unknown }).next === "object" &&
    typeof (value as { keys?: unknown }).keys === "object"
  );
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
  /** Chain and vault the ROFL key ids are counted under. See `RoflKeyStore`. */
  roflNamespace?: string | undefined;
  filePath?: string | undefined;
  /**
   * Refuse to start without an enclave.
   *
   * The fallback to `FileKeyStore` exists so the demo runs on a laptop, and it
   * writes real private keys to disk — the `[ASSUMPTION]` that `RoflKeyStore`
   * exists to retire. The danger is not that the fallback exists; it is that it
   * was *silent*. A deployment whose ROFL socket path was wrong, or whose
   * enclave had not come up yet, degraded to keys-on-disk and logged a line
   * that looked like every other startup.
   *
   * With this set, a missing socket is a refusal to boot. That is the correct
   * failure for anything holding money.
   */
  requireRofl?: boolean | undefined;
}): KeyStore {
  const socket = options.roflSocket;
  if (socket !== undefined && socket !== "") {
    return new RoflKeyStore(new SocketRoflAppd(socket), options.roflIndexPath, options.roflNamespace);
  }

  if (options.requireRofl === true) {
    throw new Error(
      "SIGNER_REQUIRE_ROFL is set but SIGNER_ROFL_SOCKET is empty. Refusing to start: the " +
        "fallback stores hold private keys in the process or on disk, which is exactly what " +
        "requiring ROFL is meant to prevent. Set SIGNER_ROFL_SOCKET, or unset " +
        "SIGNER_REQUIRE_ROFL to accept a local key store.",
    );
  }

  return options.filePath === undefined || options.filePath === ""
    ? new InMemoryKeyStore()
    : new FileKeyStore(options.filePath);
}
