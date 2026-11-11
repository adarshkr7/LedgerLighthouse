/**
 * The derived key store, against a fake `rofl-appd` and against the local seed.
 *
 * What is asserted: every key is a function of its id alone, a payer id names the
 * chain, vault, owner and enrollment id, nothing is written but a seed file, and a
 * wrong key from appd is refused loudly. What a test cannot assert: that the real
 * appd only answers inside an admitted enclave. That comes from Oasis.
 */

import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

import {
  DerivedKeyStore,
  SeedKeySource,
  enrollmentIdFrom,
  enrollmentKeyId,
  fileKeyStore,
  inMemoryKeyStore,
  normalizePrivateKey,
  openKeyStore,
  payerKeyId,
  type RoflAppd,
} from "./keystore.js";

const NS = { chainId: 84532, vault: "0x00000000000000000000000000000000000AB0B1" as Address };
const OWNER: Address = "0x000000000000000000000000000000000000A11C";
const OTHER_OWNER: Address = "0x0000000000000000000000000000000000000B0B";
const ID = enrollmentIdFrom("one");

/** Deterministic on keyId, exactly as the real appd is. Records what it was asked. */
class FakeAppd implements RoflAppd {
  readonly calls: string[] = [];
  readonly #inner = new SeedKeySource(`0x${"07".repeat(32)}`);

  async generateKey(keyId: string): Promise<Hex> {
    this.calls.push(keyId);
    return this.#inner.generateKey(keyId);
  }
}

const tempDir = (): string => mkdtempSync(join(tmpdir(), "signer-ks-"));

describe("normalizePrivateKey", () => {
  const bare = "a54027bff15a8726b6d9f65383bff20db51c6f3ac5497143a8412a7f16dfdda9";

  it("adds the 0x prefix appd omits", () => {
    expect(normalizePrivateKey(bare)).toBe(`0x${bare}`);
  });

  it("rejects a short key rather than deriving the wrong address", () => {
    expect(() => normalizePrivateKey("dead")).toThrow(/expected 64 hex chars/);
  });

  it("rejects non-hex", () => {
    expect(() => normalizePrivateKey("z".repeat(64))).toThrow(/expected 64 hex chars/);
  });
});

describe("key ids", () => {
  it("name the chain, vault, owner and enrollment id, lowercased", () => {
    expect(payerKeyId(NS, OWNER, ID)).toBe(
      `payer/84532/${NS.vault.toLowerCase()}/${OWNER.toLowerCase()}/${ID.toLowerCase()}`,
    );
  });

  it("refuse an enrollment id that is not 32 bytes", () => {
    expect(() => payerKeyId(NS, OWNER, "0x1234")).toThrow(/32 bytes/);
  });

  it("give the enrollment key no vault, so it can be read before the vault exists", () => {
    expect(enrollmentKeyId(84532)).toBe("enrollment/84532");
  });
});

describe("DerivedKeyStore over appd", () => {
  it("derives the payer from its id, so a restart needs no index", async () => {
    const appd = new FakeAppd();
    const first = await new DerivedKeyStore(appd, NS, "rofl").payer(OWNER, ID);
    const again = await new DerivedKeyStore(appd, NS, "rofl").payer(OWNER, ID);
    expect(again.address).toBe(first.address);
    expect(appd.calls).toEqual([payerKeyId(NS, OWNER, ID), payerKeyId(NS, OWNER, ID)]);
  });

  it("gives another owner, id or vault another payer", async () => {
    const appd = new FakeAppd();
    const store = new DerivedKeyStore(appd, NS, "rofl");
    const base = (await store.payer(OWNER, ID)).address;
    expect((await store.payer(OTHER_OWNER, ID)).address).not.toBe(base);
    expect((await store.payer(OWNER, enrollmentIdFrom("two"))).address).not.toBe(base);
    const otherVault = new DerivedKeyStore(appd, { ...NS, vault: OTHER_OWNER }, "rofl");
    expect((await otherVault.payer(OWNER, ID)).address).not.toBe(base);
  });

  it("keeps the enrollment key the same across vaults on one chain", async () => {
    const appd = new FakeAppd();
    const a = await new DerivedKeyStore(appd, NS, "rofl").enrollment();
    const b = await new DerivedKeyStore(appd, { ...NS, vault: OTHER_OWNER }, "rofl").enrollment();
    expect(b.address).toBe(a.address);
  });

  it("surfaces an appd failure instead of falling back to a local key", async () => {
    const broken: RoflAppd = {
      generateKey: async () => {
        throw new Error("rofl-appd returned 500");
      },
    };
    await expect(new DerivedKeyStore(broken, NS, "rofl").payer(OWNER, ID)).rejects.toThrow(/500/);
  });
});

describe("local seed stores", () => {
  it("writes only a seed, and reads it back to the same keys", async () => {
    const path = join(tempDir(), "seed.json");
    const first = fileKeyStore(path, NS);
    const a = await first.payer(OWNER, ID);
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(["seed"]);
    const b = await fileKeyStore(path, NS).payer(OWNER, ID);
    expect(b.address).toBe(a.address);
    expect(first.kind).toBe("file");
  });

  it("refuses the old address-to-key file instead of overwriting it", () => {
    const path = join(tempDir(), "payers.json");
    writeFileSync(path, JSON.stringify({ "0xabc": `0x${"11".repeat(32)}` }));
    expect(() => fileKeyStore(path, NS)).toThrow(/not a seed file/);
  });

  it("gives an in-memory store a fresh seed each time", async () => {
    const a = await inMemoryKeyStore(NS).payer(OWNER, ID);
    const b = await inMemoryKeyStore(NS).payer(OWNER, ID);
    expect(a.address).not.toBe(b.address);
  });
});

describe("openKeyStore", () => {
  it("chooses ROFL when a socket is named", () => {
    expect(openKeyStore({ ns: NS, roflSocket: "/run/rofl-appd.sock" }).kind).toBe("rofl");
  });

  it("refuses to fall back when ROFL is required", () => {
    expect(() => openKeyStore({ ns: NS, requireRofl: true })).toThrow(/Refusing to start/);
  });

  it("falls back to a seed file, then to memory", () => {
    expect(openKeyStore({ ns: NS, seedPath: join(tempDir(), "s.json") }).kind).toBe("file");
    expect(openKeyStore({ ns: NS }).kind).toBe("memory");
  });
});
