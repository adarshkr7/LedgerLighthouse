/**
 * Validation for the three fields a GPU rental request carries.
 *
 * The same arrangement `search-query.ts` describes, for the same reasons. It
 * lives in the shared package so the vendor and anything that quotes prices to
 * a viewer cannot drift on what is accepted, and the boundary check forbids the
 * orchestrator importing the vendor, so shared is the only place one definition
 * can sit.
 *
 * The vendor's pass is the load-bearing one. The orchestrator is the component
 * this architecture assumes is compromised, and the vendor holds the key that
 * spends money on real hardware, so the vendor validates what it receives and
 * does not trust whoever sent it.
 *
 * ## Reject, never repair
 *
 * A duration of 45 is not rounded to 30 and a SKU of `H100-80GB` is not
 * lowercased into a match. All three fields end up in the x402 `resource`
 * field, and the vault hashes that into `termsHash` — so quietly editing a
 * request edits what gets signed, and the thing that runs is no longer the
 * thing that was authorized.
 *
 * Case is the one worth spelling out. Accepting `H100-80GB` for `h100-80gb`
 * would mean two spellings of one rental produce two different `resource`
 * strings at one price, and the retry that pays for a quote has to reproduce
 * the quote's bytes exactly.
 */

import {
  GPU_BLOCK_MINUTES,
  findGpuSku,
  findGpuWorkload,
  type GpuBlockMinutes,
  type GpuSku,
  type GpuWorkload,
} from "./gpu-skus.js";
import type { ValidationResult } from "./search-query.js";

export type { ValidationResult };

/**
 * Resolves a SKU name to its priced definition.
 *
 * No default. A search with no tier is still a search and `basic` is an
 * unsurprising answer, but a rental with no card named is a request nobody has
 * made — and guessing the cheapest one would mean a typo in the SKU silently
 * buys different hardware at a different price.
 */
export function validateSku(raw: unknown): ValidationResult<GpuSku> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, error: "sku: required; name the card you want" };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: `sku: expected a string, got ${typeof raw}` };
  }

  const sku = findGpuSku(raw);
  if (!sku) return { ok: false, error: `sku: unknown card ${JSON.stringify(raw)}` };
  return { ok: true, value: sku };
}

/**
 * Resolves a block length to one of the durations on offer.
 *
 * Rejects anything outside the table rather than clamping to it. A caller who
 * asked for 240 minutes and got 60 would be billed for a job an order of
 * magnitude shorter than the one they think they bought, and would find out
 * when it stopped.
 */
export function validateMinutes(raw: unknown): ValidationResult<GpuBlockMinutes> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, error: "minutes: required; how long should it run" };
  }
  if (typeof raw !== "string" && typeof raw !== "number") {
    return { ok: false, error: `minutes: expected a number, got ${typeof raw}` };
  }

  // Strict: `parseInt` would take "30abc" and "0x1e", and both of those are a
  // caller who does not agree with us about what they asked for.
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) {
    return { ok: false, error: `minutes: expected a whole number, got ${JSON.stringify(text)}` };
  }

  const value = Number(text);
  const match = GPU_BLOCK_MINUTES.find((m) => m === value);
  if (match === undefined) {
    return {
      ok: false,
      error: `minutes: ${value} is not on offer; choose ${GPU_BLOCK_MINUTES.join(", ")}`,
    };
  }
  return { ok: true, value: match };
}

/**
 * Resolves a workload name to the work we are willing to run.
 *
 * See `gpu-skus.ts` for why phase 1 takes a name here and not an image and a
 * command. The short version: there is no provider behind the adapter yet, so
 * accepting an arbitrary payload would be promising something nothing can
 * honour and nothing can contain.
 */
export function validateWorkload(raw: unknown): ValidationResult<GpuWorkload> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, error: "workload: required; name the work to run" };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: `workload: expected a string, got ${typeof raw}` };
  }

  const workload = findGpuWorkload(raw);
  if (!workload) {
    return { ok: false, error: `workload: unknown workload ${JSON.stringify(raw)}` };
  }
  return { ok: true, value: workload };
}
