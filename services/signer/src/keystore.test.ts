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

import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

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

describe("RoflKeyStore key ids", () => {
  const NS = "84532/0xvault";

  it("counts key ids under the chain and vault", async () => {
    const appd = new FakeAppd();
    const store = new RoflKeyStore(appd, undefined, NS);

    await store.mint();
    await store.mint();

    expect(appd.calls).toEqual([`payer/${NS}/0`, `payer/${NS}/1`]);
  });

  it("carries the counter across a restart", async () => {
    const path = tempIndex();
    const appd = new FakeAppd();
    await new RoflKeyStore(appd, path, NS).mint();

    await new RoflKeyStore(appd, path, NS).mint();

    expect(appd.calls).toEqual([`payer/${NS}/0`, `payer/${NS}/1`]);
  });

  /*
   * What the machine expiry did to the random-id store: the disk went, and with
   * it the only record of which key id belonged to which payer.
   */
  it("rebuilds a lost index from the chain", async () => {
    const appd = new FakeAppd();
    const before = new RoflKeyStore(appd, tempIndex(), NS);
    const a = await before.mint();
    const b = await before.mint();
    const c = await before.mint();
    // a and c were bound to goals; b was minted and never used.
    const bound = new Set([a, c].map((x) => x.toLowerCase()));

    const after = new RoflKeyStore(appd, tempIndex(), NS); // a fresh, empty disk
    const rebuilt = await after.recover(async (x: Address) => bound.has(x.toLowerCase()), 3);

    expect(rebuilt).toEqual({ scanned: 6, found: 2 });
    expect((await after.signerFor(a))?.address).toBe(a);
    expect((await after.signerFor(c))?.address).toBe(c);
    expect(await after.signerFor(b)).toBeUndefined();
  });

  it("resumes past the scanned window, so no scanned id is handed out again", async () => {
    const appd = new FakeAppd();
    const store = new RoflKeyStore(appd, tempIndex(), NS);
    await store.recover(async () => false, 3);

    appd.calls.length = 0;
    await store.mint();

    expect(appd.calls).toEqual([`payer/${NS}/3`]);
  });

  it("does not rescan a namespace the index already knows", async () => {
    const path = tempIndex();
    const appd = new FakeAppd();
    await new RoflKeyStore(appd, path, NS).mint();

    const asked: Address[] = [];
    const rebuilt = await new RoflKeyStore(appd, path, NS).recover(async (x) => {
      asked.push(x);
      return false;
    });

    expect(rebuilt).toBeUndefined();
    expect(asked).toHaveLength(0);
  });

  it("refuses to guess when the chain cannot say which payers are bound", async () => {
    const store = new RoflKeyStore(new FakeAppd(), tempIndex(), NS);
    await expect(
      store.recover(() => Promise.reject(new Error("payerGoal reverted"))),
    ).rejects.toThrow(/payerGoal/);
  });

  it("skips an id after a crash between the counter and the derivation", async () => {
    const path = tempIndex();
    const real = new FakeAppd();
    let fail = true;
    const flaky: RoflAppd = {
      generateKey: (keyId) => (fail ? Promise.reject(new Error("appd went away")) : real.generateKey(keyId)),
    };

    await expect(new RoflKeyStore(flaky, path, NS).mint()).rejects.toThrow(/went away/);
    fail = false;
    await new RoflKeyStore(flaky, path, NS).mint();

    // Never payer/…/0 twice: the counter was written before the derivation failed.
    expect(real.calls).toEqual([`payer/${NS}/1`]);
  });

  it("still reads an index in the original random-id format", async () => {
    const path = tempIndex();
    const appd = new FakeAppd();
    const legacyId = "payer/0b6c8c2e-4a7f-4f43-9d3e-2a1d6b0c9f11";
    const address = privateKeyToAccount(await appd.generateKey(legacyId)).address;
    writeFileSync(path, JSON.stringify({ [address.toLowerCase()]: legacyId }));

    const store = new RoflKeyStore(appd, path, NS);

    expect((await store.signerFor(address))?.address).toBe(address);
  });
});
