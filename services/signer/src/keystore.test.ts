/**
 * `RoflKeyStore` against a fake `rofl-appd`.
 *
 * The point of the `RoflAppd` seam is that these run on a laptop with no
 * enclave. What is asserted here is everything the store is responsible for —
 * derivation determinism, that no key material is persisted, and that a wrong
 * key is rejected loudly rather than silently deriving the wrong address.
 *
 * What is *not* asserted, because a test cannot: that the real appd only answers
 * inside an attested enclave. That property comes from Oasis, not from us.
 */

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import { RoflKeyStore, normalizePrivateKey, type RoflAppd } from "./keystore.js";

/** Deterministic on keyId, exactly as the real appd is. */
class FakeAppd implements RoflAppd {
  readonly calls: string[] = [];
  #next = 1;
  readonly #issued = new Map<string, Hex>();

  async generateKey(keyId: string): Promise<Hex> {
    this.calls.push(keyId);
    const existing = this.#issued.get(keyId);
    if (existing) return existing;
    // Unprefixed, like the real daemon's `{"key": "a54027bf…"}`.
    const key = `0x${String(this.#next++).padStart(64, "0")}` as Hex;
    this.#issued.set(keyId, key);
    return key;
  }
}

const tempIndex = (): string => join(mkdtempSync(join(tmpdir(), "rofl-ks-")), "index.json");

describe("normalizePrivateKey", () => {
  const bare = "a54027bff15a8726b6d9f65383bff20db51c6f3ac5497143a8412a7f16dfdda9";

  it("adds the 0x prefix appd omits", () => {
    expect(normalizePrivateKey(bare)).toBe(`0x${bare}`);
  });

  it("accepts an already-prefixed key unchanged", () => {
    expect(normalizePrivateKey(`0x${bare}`)).toBe(`0x${bare}`);
  });

  // A truncated key would otherwise derive a valid-looking but wrong address,
  // and the first symptom would be a settlement against an unfunded payer.
  it("rejects a short key rather than deriving the wrong address", () => {
    expect(() => normalizePrivateKey("dead")).toThrow(/expected 64 hex chars/);
  });

  it("rejects non-hex", () => {
    expect(() => normalizePrivateKey("z".repeat(64))).toThrow(/expected 64 hex chars/);
  });
});

describe("RoflKeyStore", () => {
  it("mints an address and can sign for it", async () => {
    const appd = new FakeAppd();
    const store = new RoflKeyStore(appd);

    const address = await store.mint();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const account = await store.signerFor(address);
    expect(account?.address).toBe(address);
  });

  it("re-derives the same key rather than minting a new one", async () => {
    const appd = new FakeAppd();
    const store = new RoflKeyStore(appd);

    const address = await store.mint();
    const first = await store.signerFor(address);
    const second = await store.signerFor(address);

    expect(first?.address).toBe(second?.address);
    // One mint plus two derivations, all naming the same key_id.
    expect(appd.calls).toHaveLength(3);
    expect(new Set(appd.calls).size).toBe(1);
  });

  it("returns undefined for an address it never minted", async () => {
    const store = new RoflKeyStore(new FakeAppd());
    const stranger = privateKeyToAccount(`0x${"7".repeat(64)}`).address;
    expect(await store.signerFor(stranger)).toBeUndefined();
  });

  it("gives each mint a distinct key_id", async () => {
    const appd = new FakeAppd();
    const store = new RoflKeyStore(appd);

    const a = await store.mint();
    const b = await store.mint();

    expect(a).not.toBe(b);
    expect(new Set(appd.calls).size).toBe(2);
  });

  // The whole reason this store is an upgrade on FileKeyStore.
  it("persists no key material — only address -> key_id", async () => {
    const path = tempIndex();
    const appd = new FakeAppd();
    const store = new RoflKeyStore(appd, path);

    const address = await store.mint();
    const account = await store.signerFor(address);
    const written = readFileSync(path, "utf8");

    expect(written).toContain(address.toLowerCase());
    expect(written).toContain("payer/");
    // The derived private key must appear nowhere in the file.
    const key = `0x${"0".repeat(63)}1`;
    expect(written).not.toContain(key);
    expect(written).not.toContain(key.slice(2));
    expect(account).toBeDefined();
  });

  it("recovers keys across a restart from the non-secret index", async () => {
    const path = tempIndex();
    const appd = new FakeAppd();

    const address = await new RoflKeyStore(appd, path).mint();

    // Fresh store, same appd and index — as after a container restart.
    const revived = new RoflKeyStore(appd, path);
    const account = await revived.signerFor(address);

    expect(account?.address).toBe(address);
    expect(await revived.addresses()).toContain(address.toLowerCase());
  });

  it("keeps nothing on disk when no index path is configured", async () => {
    const path = tempIndex();
    const store = new RoflKeyStore(new FakeAppd());
    await store.mint();
    expect(existsSync(path)).toBe(false);
  });

  it("surfaces an appd failure instead of falling back to a local key", async () => {
    const broken: RoflAppd = {
      generateKey: () => Promise.reject(new Error("rofl-appd unreachable at /run/rofl-appd.sock")),
    };
    await expect(new RoflKeyStore(broken).mint()).rejects.toThrow(/unreachable/);
  });
});
