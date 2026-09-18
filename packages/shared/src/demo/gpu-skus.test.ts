import { describe, expect, it } from "vitest";

import {
  GPU_BLOCK_MINUTES,
  GPU_SKUS,
  GPU_SKU_NAMES,
  GPU_WORKLOAD_NAMES,
  assumedCostAtomic,
  quoteAtomic,
} from "./gpu-skus.js";
import { validateMinutes, validateSku, validateWorkload } from "./gpu-request.js";

/**
 * The per-call cap the demo goals are opened with.
 *
 * Mirrors `apps/web/src/App.tsx`, which is where the console sets it. Copied
 * rather than imported because the shared package does not depend on the web
 * app, and the reason to copy it is the assertion below: a SKU priced above the
 * public cap would be refused by a `require` in the vault instead of by the
 * encrypted budget, which is the one thing the catalog exists to demonstrate.
 */
const PER_CALL_CAP = 6_000_000n;

describe("GPU pricing", () => {
  it("quotes the per-minute price times the block length", () => {
    const sku = GPU_SKUS.rtx4090;
    expect(quoteAtomic(sku, 15)).toBe("120000"); // 0.12 USDC
    expect(quoteAtomic(sku, 30)).toBe("240000");
    expect(quoteAtomic(sku, 60)).toBe("480000");
  });

  /*
   * Plan §5.6. The 402 states `maxAmountRequired` before any work happens and
   * the vault freezes it into `termsHash`, so the quote and the retry that pays
   * it have to agree byte for byte — forever, not just within one process.
   */
  it("quotes the same number every time for the same request", () => {
    for (const name of GPU_SKU_NAMES) {
      for (const minutes of GPU_BLOCK_MINUTES) {
        const first = quoteAtomic(GPU_SKUS[name], minutes);
        expect(quoteAtomic(GPU_SKUS[name], minutes)).toBe(first);
      }
    }
  });

  /*
   * The whole argument. If a rental could exceed the public per-call cap, the
   * vault would refuse it with `AmountExceedsCap` and the refusal would prove
   * nothing about a confidential budget — the same trap `compliance-audit` is
   * priced to avoid in the search catalog.
   */
  it("keeps every offer under the public per-call cap", () => {
    for (const name of GPU_SKU_NAMES) {
      for (const minutes of GPU_BLOCK_MINUTES) {
        const quoted = BigInt(quoteAtomic(GPU_SKUS[name], minutes));
        expect(quoted).toBeLessThan(PER_CALL_CAP);
      }
    }
  });

  /*
   * The costs are assumed rather than measured, so this does not assert a
   * margin figure. It asserts the sign: a SKU quoted below what we think it
   * costs is a table entry someone fat-fingered, and it would lose money on
   * every call without anything else in the system objecting.
   */
  it("never quotes below the assumed cost", () => {
    for (const name of GPU_SKU_NAMES) {
      for (const minutes of GPU_BLOCK_MINUTES) {
        const quoted = BigInt(quoteAtomic(GPU_SKUS[name], minutes));
        const assumed = BigInt(assumedCostAtomic(GPU_SKUS[name], minutes));
        expect(quoted).toBeGreaterThan(assumed);
      }
    }
  });

  it("prices the spread the demo argument depends on", () => {
    // One 4090 block fits the 0.20 demo budget; a second one does not, and an
    // H100 block does not fit at all. Three outcomes from one hidden number.
    const budget = 200_000n;
    const cheapest = BigInt(quoteAtomic(GPU_SKUS.rtx4090, 15));
    expect(cheapest).toBeLessThan(budget);
    expect(cheapest * 2n).toBeGreaterThan(budget);
    expect(BigInt(quoteAtomic(GPU_SKUS["h100-80gb"], 15))).toBeGreaterThan(budget);
  });
});

describe("GPU request validation", () => {
  it("resolves a known SKU, block length and workload", () => {
    expect(validateSku("a100-40gb")).toEqual({ ok: true, value: GPU_SKUS["a100-40gb"] });
    expect(validateMinutes("30")).toEqual({ ok: true, value: 30 });
    expect(validateMinutes(60)).toEqual({ ok: true, value: 60 });
    const workload = validateWorkload("gpu-burn");
    expect(workload.ok && workload.value.name).toBe("gpu-burn");
  });

  /*
   * No defaults here, unlike the search tier. A search with no tier named is
   * still a search; a rental with no card named is a request nobody made, and
   * guessing the cheapest would let a typo buy different hardware.
   */
  it("requires all three fields rather than guessing", () => {
    expect(validateSku(undefined).ok).toBe(false);
    expect(validateMinutes(undefined).ok).toBe(false);
    expect(validateWorkload(undefined).ok).toBe(false);
    expect(validateSku("").ok).toBe(false);
  });

  /*
   * Reject, never repair. All three fields land in the x402 `resource` string
   * that the vault hashes into `termsHash`, so accepting a second spelling of
   * one rental would mean two `resource` values at one price — and the retry
   * that pays for a quote has to reproduce the quote's bytes exactly.
   */
  it("does not fold case into a match", () => {
    expect(validateSku("H100-80GB").ok).toBe(false);
    expect(validateSku("RTX4090").ok).toBe(false);
    expect(validateWorkload("GPU-Burn").ok).toBe(false);
  });

  it("refuses a duration off the table rather than clamping to it", () => {
    for (const bad of ["240", "1", "0", "45", "16"]) {
      const result = validateMinutes(bad);
      expect(result.ok, `minutes=${bad} should be refused`).toBe(false);
    }
    // Named, so the caller can fix it without reading the source.
    const refused = validateMinutes("45");
    expect(refused.ok === false && refused.error).toContain("15, 30, 60");
  });

  it("refuses a duration that only looks numeric", () => {
    // `parseInt` would take both of these and agree with neither caller.
    expect(validateMinutes("30abc").ok).toBe(false);
    expect(validateMinutes("0x1e").ok).toBe(false);
    expect(validateMinutes("15.0").ok).toBe(false);
    expect(validateMinutes(" 30 ").ok).toBe(true); // surrounding space is not a disagreement
  });

  it("refuses an unknown SKU and workload by name", () => {
    const sku = validateSku("tpu-v5");
    expect(sku.ok === false && sku.error).toContain("tpu-v5");
    const workload = validateWorkload("rm -rf /");
    expect(workload.ok === false && workload.error).toContain("unknown workload");
  });

  it("accepts every name it publishes", () => {
    for (const name of GPU_SKU_NAMES) expect(validateSku(name).ok).toBe(true);
    for (const name of GPU_WORKLOAD_NAMES) expect(validateWorkload(name).ok).toBe(true);
    for (const minutes of GPU_BLOCK_MINUTES) expect(validateMinutes(minutes).ok).toBe(true);
  });
});
