/**
 * Tests for the rate limit on the enclave's key operations.
 *
 * The properties that matter are about *what reaches `rofl-appd`*, so the
 * assertions count calls on a fake store rather than inspecting the limiter.
 * A limiter that returns the right booleans while still letting the call
 * through would pass an introspective test and fail the only one that counts.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, LocalAccount } from "viem";

import {
  DEFAULT_ENCLAVE_LIMITS,
  EnclaveRateLimitError,
  RateLimitedKeyStore,
  describeEnclaveLimits,
  enclaveLimitsFromEnv,
} from "./enclave-limit.js";
import type { KeyStore } from "./keystore.js";

const KEY: Hex = `0x${"11".repeat(32)}`;
const ACCOUNT = privateKeyToAccount(KEY);

/** Counts what the enclave would have been asked to do. */
class CountingKeyStore implements KeyStore {
  mints = 0;
  derives = 0;
  listings = 0;

  async mint(): Promise<Address> {
    this.mints += 1;
    return ACCOUNT.address;
  }

  async signerFor(_address: Address): Promise<LocalAccount | undefined> {
    this.derives += 1;
    return ACCOUNT;
  }

  async addresses(): Promise<readonly Address[]> {
    this.listings += 1;
    return [ACCOUNT.address];
  }
}

/** Drains a limiter's whole allowance, asserting every call got through. */
async function exhaust(fn: () => Promise<unknown>, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) await fn();
}

describe("RateLimitedKeyStore", () => {
  let inner: CountingKeyStore;

  beforeEach(() => {
    inner = new CountingKeyStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes calls through while under the limit", async () => {
    const store = new RateLimitedKeyStore(inner, { mintPerMinute: 3, derivePerMinute: 3 });

    expect(await store.mint()).toBe(ACCOUNT.address);
    expect(await store.signerFor(ACCOUNT.address)).toBe(ACCOUNT);

    expect(inner.mints).toBe(1);
    expect(inner.derives).toBe(1);
  });

  it("stops minting at the cap, and does not reach the store to do it", async () => {
    const store = new RateLimitedKeyStore(inner, { mintPerMinute: 2, derivePerMinute: 100 });

    await exhaust(() => store.mint(), 2);
    await expect(store.mint()).rejects.toThrow(EnclaveRateLimitError);

    // The third call must not have generated a key. This is the whole point:
    // a refusal that still derives is not a limit on the enclave.
    expect(inner.mints).toBe(2);
  });

  it("stops deriving at the cap", async () => {
    const store = new RateLimitedKeyStore(inner, { mintPerMinute: 100, derivePerMinute: 2 });

    await exhaust(() => store.signerFor(ACCOUNT.address), 2);
    await expect(store.signerFor(ACCOUNT.address)).rejects.toThrow(EnclaveRateLimitError);

    expect(inner.derives).toBe(2);
  });

  it("meters mint and derive independently", async () => {
    const store = new RateLimitedKeyStore(inner, { mintPerMinute: 1, derivePerMinute: 5 });

    await store.mint();
    await expect(store.mint()).rejects.toThrow(EnclaveRateLimitError);

    // Signing is the path a debited spend depends on. Exhausting mints must
    // not take it down with them.
    await exhaust(() => store.signerFor(ACCOUNT.address), 5);
    expect(inner.derives).toBe(5);
  });

  it("is global rather than per-address — one payer can exhaust the derive budget", async () => {
    const store = new RateLimitedKeyStore(inner, { mintPerMinute: 100, derivePerMinute: 2 });
    const other: Address = "0x2222222222222222222222222222222222222222";

    await exhaust(() => store.signerFor(ACCOUNT.address), 2);

    // Deliberate: the resource being protected is the one key daemon, and it
    // does not care which address the derivation names.
    await expect(store.signerFor(other)).rejects.toThrow(EnclaveRateLimitError);
  });

  it("recovers when the window rolls over", async () => {
    const store = new RateLimitedKeyStore(inner, { mintPerMinute: 1, derivePerMinute: 1 });

    await store.mint();
    await expect(store.mint()).rejects.toThrow(EnclaveRateLimitError);

    vi.advanceTimersByTime(60_001);

    await expect(store.mint()).resolves.toBe(ACCOUNT.address);
    expect(inner.mints).toBe(2);
  });

  it("reports a usable retry-after and the operation that tripped", async () => {
    const store = new RateLimitedKeyStore(inner, { mintPerMinute: 1, derivePerMinute: 1 });

    await store.mint();
    vi.advanceTimersByTime(20_000);

    const error = await store.mint().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnclaveRateLimitError);
    const limit = error as EnclaveRateLimitError;

    expect(limit.operation).toBe("mint");
    // 60s window, 20s elapsed. Never 0, which would invite an instant retry.
    expect(limit.retryAfterSeconds).toBe(40);
    expect(limit.message).toContain("40s");
  });

  it("leaves the message free of anything a caller should not learn", async () => {
    const store = new RateLimitedKeyStore(inner, { mintPerMinute: 1, derivePerMinute: 1 });
    await store.mint();

    const error = (await store.mint().catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain(ACCOUNT.address);
  });

  it("does not limit addresses(), which never touches the enclave", async () => {
    const store = new RateLimitedKeyStore(inner, { mintPerMinute: 1, derivePerMinute: 1 });

    await exhaust(() => store.addresses(), 50);
    expect(inner.listings).toBe(50);
  });
});

describe("enclaveLimitsFromEnv", () => {
  it("defaults when unset", () => {
    expect(enclaveLimitsFromEnv({})).toEqual(DEFAULT_ENCLAVE_LIMITS);
  });

  it("treats an empty value as unset, because .env writes them that way", () => {
    expect(
      enclaveLimitsFromEnv({ SIGNER_ENCLAVE_MINT_PER_MIN: "", SIGNER_ENCLAVE_DERIVE_PER_MIN: "  " }),
    ).toEqual(DEFAULT_ENCLAVE_LIMITS);
  });

  it("reads both settings", () => {
    expect(
      enclaveLimitsFromEnv({
        SIGNER_ENCLAVE_MINT_PER_MIN: "5",
        SIGNER_ENCLAVE_DERIVE_PER_MIN: "50",
      }),
    ).toEqual({ mintPerMinute: 5, derivePerMinute: 50 });
  });

  // Each of these is a way a typo could silently become "no limit" or
  // "refuse everything" on the process that holds the payer keys.
  it.each([["0"], ["-1"], ["1.5"], ["abc"], ["30/min"], ["Infinity"]])(
    "refuses to start on %s",
    (value) => {
      expect(() => enclaveLimitsFromEnv({ SIGNER_ENCLAVE_MINT_PER_MIN: value })).toThrow(
        /SIGNER_ENCLAVE_MINT_PER_MIN must be a positive integer/,
      );
    },
  );
});

describe("describeEnclaveLimits", () => {
  it("says the numbers and that they are global", () => {
    expect(describeEnclaveLimits({ mintPerMinute: 30, derivePerMinute: 240 })).toBe(
      "mint 30/min · derive 240/min (global)",
    );
  });
});
