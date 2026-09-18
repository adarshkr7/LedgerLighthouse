/**
 * What a rented GPU costs, and what we charge for it.
 *
 * The successor to `search-tiers.ts`, and the same shape for the same reason:
 * x402 makes the resource server state `maxAmountRequired` in the 402, before
 * any work happens. So the vendor cannot bill what a job actually used. It has
 * to quote a price that is a deterministic function of the request and absorb
 * the difference, which is what `docs/GPU_RENTAL_PLAN.md` §5.6 requires and
 * what spot pricing inside the 402 would break the first time a provider moved
 * its price between the quote and the paid retry.
 *
 * The request names a SKU and a duration. It never names a price, an image or a
 * machine count. That is the same rule the search tiers enforce: a request that
 * could dial `search_depth` could dial our cost, and a request that could dial
 * `maxAmountRequired` could dial what the vault is asked to approve.
 *
 * ## These costs are assumed, not measured
 *
 * `search-tiers.ts` carries a `VERIFIED_ON` date because those numbers came out
 * of `scripts/search-measure-tiers.mjs` running against the live API. Nothing
 * equivalent exists here yet. No provider has been chosen — plan §8 question 1
 * says provisioning latency decides it and nobody has measured that either —
 * so `assumedHourlyCostAtomic` below is a placeholder drawn from public list
 * pricing for commodity GPU rental, rounded, and it is wrong by an unknown
 * amount.
 *
 * What is *not* assumed is `pricePerMinuteAtomic`. That is a price we set, and
 * it is as real as any price on an offer. The margin between the two is the
 * only thing the placeholder puts in doubt.
 *
 * Plan phase 4 brings the measurement script that replaces the assumption. Until
 * it runs, `SpendLedger` is what keeps a wrong assumption bounded: it counts in
 * money against a ceiling, so a SKU that costs four times what this file thinks
 * runs out of ceiling instead of running out of balance.
 *
 * ## Units
 *
 * USDC atomic units throughout, which are millionths of a dollar and therefore
 * also micros USD — the unit providers report cost in. Nothing here converts
 * anything.
 */

/** Where the cost column came from, said plainly so nobody reads it as measured. */
export const COST_BASIS =
  "assumed from public list pricing, not measured against a provider (plan §8 q1, phase 4)";

/** Date the assumptions below were written down. */
export const ASSUMED_ON = "2026-09-19";

export type GpuSkuName = "rtx4090" | "a100-40gb" | "h100-80gb";

export interface GpuSku {
  readonly name: GpuSkuName;
  /** Marketing name, for the 402 description and the console. */
  readonly label: string;
  readonly vramGb: number;
  /**
   * What an hour of this card is assumed to cost us. A placeholder — see the
   * header. Named `assumed` so no caller can mistake it for a measurement.
   */
  readonly assumedHourlyCostAtomic: string;
  /**
   * What we charge, per minute. The 402 quotes this multiplied by the requested
   * duration, and that multiplication is the whole pricing function.
   */
  readonly pricePerMinuteAtomic: string;
  readonly blurb: string;
}

/**
 * Three cards, chosen for the spread rather than for the catalogue.
 *
 * Every price below sits under the 6.00 USDC per-call cap the demo goals carry,
 * and that is the point of picking them. The public cap never refuses a rental,
 * so the only thing in the system that can refuse one is the encrypted budget —
 * which is the argument `compliance-audit` makes in the search catalog, made
 * again against a bill people actually recognise.
 *
 * Against the 0.20 USDC demo budget the spread does the rest: fifteen minutes
 * of a 4090 costs 0.12 and settles, a second one does not fit, and fifteen
 * minutes of an H100 is refused on the first try. Three different outcomes from
 * one budget nobody can read.
 */
export const GPU_SKUS: Readonly<Record<GpuSkuName, GpuSku>> = {
  rtx4090: {
    name: "rtx4090",
    label: "RTX 4090 24GB",
    vramGb: 24,
    assumedHourlyCostAtomic: "340000", // ~$0.34/hr
    pricePerMinuteAtomic: "8000", // $0.008/min = $0.48/hr
    blurb: "Consumer card, 24GB — fine-tuning and inference, the ordinary case",
  },
  "a100-40gb": {
    name: "a100-40gb",
    label: "A100 40GB",
    vramGb: 40,
    assumedHourlyCostAtomic: "1190000", // ~$1.19/hr
    pricePerMinuteAtomic: "28000", // $0.028/min = $1.68/hr
    blurb: "Datacentre card, 40GB — the default for a real training run",
  },
  "h100-80gb": {
    name: "h100-80gb",
    label: "H100 80GB",
    vramGb: 80,
    assumedHourlyCostAtomic: "2690000", // ~$2.69/hr
    pricePerMinuteAtomic: "60000", // $0.060/min = $3.60/hr
    blurb: "80GB and the fastest interconnect — the one that runs up a bill",
  },
} as const;

export const GPU_SKU_NAMES = Object.keys(GPU_SKUS) as readonly GpuSkuName[];

export function findGpuSku(name: string): GpuSku | undefined {
  return (GPU_SKUS as Record<string, GpuSku>)[name];
}

/**
 * Durations a job may be bought for, in minutes.
 *
 * A fixed set rather than any integer, so the price is a lookup and a
 * multiplication over a domain small enough to enumerate in a test. It also
 * keeps the 402's `resource` field drawn from a closed vocabulary, which is
 * what has to be byte-identical between the quote and the paid retry.
 *
 * Fifteen minutes is the floor because plan §5.5 puts it there: a renewal has
 * to begin a full decision cycle before its block ends, the observed cycle is
 * up to 13.8 seconds, and a block short enough to spend its life renewing is
 * not a block. Phase 1 buys one job rather than a renewable lease, so the floor
 * binds nothing here — it is set now so phase 2 inherits a vocabulary it does
 * not have to change.
 */
export const GPU_BLOCK_MINUTES = [15, 30, 60] as const;

export type GpuBlockMinutes = (typeof GPU_BLOCK_MINUTES)[number];

/**
 * Work a caller may ask for, by name.
 *
 * Phase 1 does not accept an image reference or a command line. Renting a GPU
 * does eventually mean running the renter's code on it, and that is a
 * provisioning and isolation problem this increment has no answer to: there is
 * no real provider behind the adapter yet, so an arbitrary payload would be
 * accepted by something that cannot honour it and cannot contain it either.
 *
 * A named workload keeps the request a closed vocabulary until the provider
 * exists. It costs the product nothing today, because what the stand-in adapter
 * can honestly do is occupy a card and report what happened.
 */
export type GpuWorkloadName = "gpu-burn" | "matmul-bench" | "model-warmup";

export interface GpuWorkload {
  readonly name: GpuWorkloadName;
  readonly label: string;
  readonly blurb: string;
}

export const GPU_WORKLOADS: Readonly<Record<GpuWorkloadName, GpuWorkload>> = {
  "gpu-burn": {
    name: "gpu-burn",
    label: "Occupancy burn",
    blurb: "Saturates the card for the whole block and reports sustained utilisation",
  },
  "matmul-bench": {
    name: "matmul-bench",
    label: "Matmul throughput",
    blurb: "Dense matrix multiply at several sizes, reported in TFLOP/s",
  },
  "model-warmup": {
    name: "model-warmup",
    label: "Model warm-up",
    blurb: "Loads weights and measures time to first token, then exits",
  },
} as const;

export const GPU_WORKLOAD_NAMES = Object.keys(GPU_WORKLOADS) as readonly GpuWorkloadName[];

export function findGpuWorkload(name: string): GpuWorkload | undefined {
  return (GPU_WORKLOADS as Record<string, GpuWorkload>)[name];
}

/**
 * The whole pricing function: a SKU's per-minute price times a block length.
 *
 * Deterministic by construction, which is the property plan §5.6 asks for. Two
 * calls with the same SKU and the same duration quote the same number forever,
 * so the 402 and the retry that pays it cannot disagree and the vault's frozen
 * `termsHash` stays true.
 */
export function quoteAtomic(sku: GpuSku, minutes: number): string {
  return (BigInt(sku.pricePerMinuteAtomic) * BigInt(minutes)).toString();
}

/**
 * What a block is assumed to cost us, for the margin line in the response.
 *
 * Integer division, truncating: an hourly figure divided by sixty does not land
 * on a whole micro for every card here. Truncation understates the cost, which
 * overstates the margin, and a margin that reads a shade optimistic is the
 * harmless direction for a number this file has already said is assumed.
 */
export function assumedCostAtomic(sku: GpuSku, minutes: number): string {
  return ((BigInt(sku.assumedHourlyCostAtomic) * BigInt(minutes)) / 60n).toString();
}
