/**
 * What a live AIsa search costs, and what we charge for it.
 *
 * x402 makes the resource server state
 * `maxAmountRequired` in the 402, which is emitted *before* the upstream call
 * happens. So the shim cannot bill actual cost — it has to quote a price that
 * is a deterministic function of the request, and absorb any difference.
 *
 * Kept beside the goal catalog for the same reason the goal catalog exists: the
 * vendor quotes these, the console displays them, and a second copy is a copy
 * that will eventually disagree.
 *
 * ## Where these numbers come from
 *
 * Measured, not published. AIsa lists no price on the Tavily endpoint's
 * reference page, and their pricing guidance says to determine cost with
 * representative requests rather than copying a figure out of an article.
 * `scripts/aisa-measure-tiers.mjs` is that measurement; re-run it to refresh
 * `VERIFIED_ON`.
 *
 * The response carries two undocumented headers — `x-aisa-customer-cost-micros-usd`
 * and `x-aisa-provider-cost-micros-usd` — reporting exact cost in millionths of
 * a dollar. USDC also has six decimals, so **a micros-USD figure is already a
 * USDC atomic amount**, and no conversion is needed anywhere in this file.
 *
 * ## What the measurement showed
 *
 * Cost tracks `search_depth` and nothing else. `max_results` was varied from 5
 * to 10 at both depths and moved the price not at all, which is why the tier is
 * named for depth alone and `maxResults` rides along as a quality knob rather
 * than a pricing input.
 *
 * At the time of measurement customer cost equalled provider cost exactly at
 * both depths, so AIsa was passing this endpoint through without a markup of
 * its own. That is theirs to change and nothing here should assume it holds.
 */

/** Date the costs below were last confirmed against the live API. */
export const VERIFIED_ON = "2026-08-22";

export type SearchTierName = "basic" | "deep";

export interface SearchTier {
  readonly name: SearchTierName;
  /** Tavily's `search_depth`. The only parameter that moved the price. */
  readonly searchDepth: "basic" | "advanced";
  /**
   * Tavily's `max_results`. Priced identically at 5 and 10, and not guaranteed:
   * a `basic` call asking for 10 came back with 9.
   */
  readonly maxResults: number;
  /** Measured upstream cost, USDC atomic units (= micros USD). */
  readonly measuredCostAtomic: string;
  /** What the 402 asks for. Cost plus margin, rounded to something legible. */
  readonly priceAtomic: string;
  /** Observed end-to-end latency of the upstream call, for UI expectations. */
  readonly observedLatencyMs: number;
  readonly label: string;
  readonly blurb: string;
}

/**
 * Two tiers, because the measurement found two prices.
 *
 * The margin is ~25%, which lands both on round numbers a viewer can hold in
 * their head — 0.01 and 0.02 USDC. That matters more than the exact percentage
 * here: these are displayed next to a budget the viewer chose, and a price like
 * 0.0104 reads as noise rather than as a price.
 *
 * Both sit far below the 6.00 per-call cap and well inside the 0.20 demo
 * budget, so a viewer can run a dozen real searches and watch the encrypted
 * balance draw down before anything is refused — a different demonstration from
 * the single over-budget bounce, and a complementary one: the budget is a
 * running total the agent cannot read, not a per-call limit.
 */
export const SEARCH_TIERS: Readonly<Record<SearchTierName, SearchTier>> = {
  basic: {
    name: "basic",
    searchDepth: "basic",
    maxResults: 5,
    measuredCostAtomic: "8000", // $0.008
    priceAtomic: "10000", // 0.01 USDC
    observedLatencyMs: 3600,
    label: "AIsa web search",
    blurb: "Live results from AIsa's search API — the ordinary case",
  },
  deep: {
    name: "deep",
    searchDepth: "advanced",
    maxResults: 10,
    measuredCostAtomic: "16000", // $0.016
    priceAtomic: "20000", // 0.02 USDC
    observedLatencyMs: 9800,
    label: "AIsa deep search",
    blurb: "Advanced depth, more sources — twice the price, three times the wait",
  },
} as const;

export const SEARCH_TIER_NAMES = Object.keys(SEARCH_TIERS) as readonly SearchTierName[];

export function findSearchTier(name: string): SearchTier | undefined {
  return (SEARCH_TIERS as Record<string, SearchTier>)[name];
}

/**
 * Headers AIsa returns with the true cost of a call.
 *
 * Undocumented, so read defensively and never required: a shim that refuses to
 * serve because a header went missing would be trading a working product for a
 * reconciliation figure. Absent, the quoted price stands unreconciled and the
 * trace records that it could not be checked.
 */
export const COST_HEADER_CUSTOMER = "x-aisa-customer-cost-micros-usd";
export const COST_HEADER_PROVIDER = "x-aisa-provider-cost-micros-usd";

/**
 * True when a call cost more than the tier quoted for it.
 *
 * The shim absorbs the difference — a fixed-price offer that re-bills after the
 * fact is not a fixed-price offer — but an overrun means the table is stale and
 * belongs in the log and the trace.
 */
export function costExceededQuote(tier: SearchTier, actualCostAtomic: string): boolean {
  return BigInt(actualCostAtomic) > BigInt(tier.priceAtomic);
}
