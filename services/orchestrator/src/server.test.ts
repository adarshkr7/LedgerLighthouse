import { describe, expect, it } from "vitest";

import { DEMO_GOALS, MOCK_GOALS, SEARCH_TIERS, findDemoGoal, isMockGoal } from "@ntux402/shared";

import { resourceUrlFor } from "./server.js";

const MOCK = "http://mock.test";
const VENDOR = "http://vendor.test";

const urlFor = (mode: string, extra: Record<string, string | undefined> = {}) =>
  resourceUrlFor({ mode, mockApiUrl: MOCK, vendorAisaUrl: VENDOR, ...extra });

describe("resourceUrlFor", () => {
  it("sends mock-served goals to the mock vendor", () => {
    for (const goal of MOCK_GOALS) {
      expect(urlFor(goal.key), goal.key).toBe(`${MOCK}/resource/${goal.key}`);
    }
  });

  it("sends upstream goals to the AIsa vendor, never the mock", () => {
    const live = DEMO_GOALS.filter((g) => g.upstream !== undefined);
    expect(live.length).toBeGreaterThan(0);

    for (const goal of live) {
      const url = urlFor(goal.key);
      expect(url, goal.key).toContain(`${VENDOR}/resource/aisa/search`);
      expect(url, goal.key).not.toContain(MOCK);
    }
  });

  /*
   * Routing is on the `upstream` field, not on the shape of the key. A
   * name-prefix rule would send a renamed goal to the wrong server, and the
   * failure mode is a 200 carrying the wrong product at the right price.
   */
  it("routes on the upstream field rather than the key's name", () => {
    for (const goal of DEMO_GOALS) {
      const wentToVendor = urlFor(goal.key).startsWith(VENDOR);
      expect(wentToVendor, goal.key).toBe(!isMockGoal(goal));
    }
  });

  it("carries the tier and the goal's default query", () => {
    const goal = findDemoGoal("aisa-search-deep");
    const url = new URL(urlFor("aisa-search-deep"));
    expect(url.searchParams.get("tier")).toBe("deep");
    expect(url.searchParams.get("q")).toBe(goal?.upstream?.defaultQuery);
  });

  it("prefers an explicit query over the default", () => {
    const url = new URL(urlFor("aisa-search-basic", { query: "what is x402" }));
    expect(url.searchParams.get("q")).toBe("what is x402");
  });

  /*
   * The query becomes the x402 `resource`, which `requireResource` demands be
   * URL-shaped and which the vault hashes into `termsHash`. A raw space breaks
   * parsing; an unescaped `&` or `#` would smuggle structure into what is
   * signed.
   */
  it("encodes a query so it cannot break out of the query string", () => {
    const nasty = "a b&tier=deep#frag/../../etc";
    const raw = urlFor("aisa-search-basic", { query: nasty });

    // Exactly one `?`, and the tier is still the goal's own.
    expect(raw.split("?")).toHaveLength(2);
    const url = new URL(raw);
    expect(url.searchParams.get("q")).toBe(nasty);
    expect(url.searchParams.get("tier")).toBe("basic");
    expect(url.pathname).toBe("/resource/aisa/search");
  });

  it("honours the price override only on the mock path", () => {
    expect(urlFor("compliance-audit", { priceAtomic: "350000" })).toBe(
      `${MOCK}/resource/compliance-audit?price=350000`,
    );
    // The live vendor prices from the tier table; a caller cannot retune it.
    expect(urlFor("aisa-search-basic", { priceAtomic: "999" })).not.toContain("999");
  });

  it("quotes each live goal at its measured tier price", () => {
    expect(findDemoGoal("aisa-search-basic")?.priceAtomic).toBe(SEARCH_TIERS.basic.priceAtomic);
    expect(findDemoGoal("aisa-search-deep")?.priceAtomic).toBe(SEARCH_TIERS.deep.priceAtomic);
  });
});
