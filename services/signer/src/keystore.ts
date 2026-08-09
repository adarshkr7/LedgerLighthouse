/**
 * Custody of the per-goal ephemeral payer keys. **[ASSUMPTION]** — Inco provides
 * no key custody and no signing, so this component exists because it must, not
 * because it is desirable (plan §7.7).
 *
 * Two properties the rest of the design leans on:
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
 *
 * File-backed JSON is a hackathon decision, stated openly rather than dressed
 * up: production is a KMS. `SIGNER_KEY_STORE_PATH` names the file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, LocalAccount } from "viem";

/** Serialised form. Addresses are stored lowercased so lookup is unambiguous. */
type StoreFile = Record<string, Hex>;

export interface KeyStore {
  /** Generates a fresh payer key and returns **only** its address. */
  mint(): Address;
  /** The signing account for a payer address, or undefined if we hold no key. */
  signerFor(address: Address): LocalAccount | undefined;
  /** Addresses we hold keys for. Diagnostics only. */
  addresses(): readonly Address[];
}

export class InMemoryKeyStore implements KeyStore {
  readonly #keys = new Map<string, Hex>();

  mint(): Address {
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

  signerFor(address: Address): LocalAccount | undefined {
    const key = this.#keys.get(address.toLowerCase());
    return key === undefined ? undefined : privateKeyToAccount(key);
  }

  addresses(): readonly Address[] {
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

  mint(): Address {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    this.#cache[account.address.toLowerCase()] = key;
    this.#write();
    return account.address;
  }

  signerFor(address: Address): LocalAccount | undefined {
    const key = this.#cache[address.toLowerCase()];
    return key === undefined ? undefined : privateKeyToAccount(key);
  }

  addresses(): readonly Address[] {
    return Object.values(this.#cache).map((k) => privateKeyToAccount(k).address);
  }
}

export function openKeyStore(path: string | undefined): KeyStore {
  return path === undefined || path === "" ? new InMemoryKeyStore() : new FileKeyStore(path);
}
