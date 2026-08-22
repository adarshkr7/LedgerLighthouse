import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEMO_GOALS, MOCK_GOALS, SEARCH_TIERS, findDemoGoal, isMockGoal } from "@ntux402/shared";
import type { Address } from "viem";

import { createOrchestratorServer, resourceUrlFor } from "./server.js";
import type { PaymentLoop } from "./pay/payment-loop.js";
import type { VaultRelay } from "./pay/relay.js";

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

/*
 * The request bodies, over a real socket.
 *
 * The signer and the facilitator both capped theirs and this service did not,
 * which made it the cheapest of the three to push over with a large body. These
 * drive the actual `node:http` server rather than the handler, because the cap
 * lives in the read loop and a test calling the handler directly would never
 * exercise it.
 */
describe("request bodies", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createOrchestratorServer({
      // Never reached: every case below is refused before a run starts.
      loop: { fetchPaid: async () => ({ kind: "failed", reason: "unreached" }) } as unknown as PaymentLoop,
      relay: { relayAddress: `0x${"11".repeat(20)}` as Address } as unknown as VaultRelay,
      vaultAddress: `0x${"22".repeat(20)}`,
      usdcAddress: `0x${"33".repeat(20)}`,
      chainId: 84532,
      mockApiUrl: "http://mock.test",
      vendorAisaUrl: undefined,
      vendorAisaPayee: undefined,
      signerUrl: "http://signer.test",
      anchors: undefined,
      facilitatorUrl: undefined,
      agentSource: "scripted",
      traceDir: mkdtempSync(join(tmpdir(), "ll-traces-")),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  /** `res.json()` is `unknown` under this tsconfig; the refusals all carry `error`. */
  const errorOf = async (res: Response): Promise<string> =>
    String((await res.json() as { error?: unknown }).error);

  it("refuses an oversized body with 413 rather than buffering it", async () => {
    const huge = JSON.stringify({ goalId: "1", mode: "market-data", query: "x".repeat(32_000) });
    for (const path of ["/runs", "/sweeps"]) {
      const res = await post(path, huge);
      expect(res.status, path).toBe(413);
      expect(await errorOf(res), path).toMatch(/exceeds/);
    }
  });

  /*
   * A malformed body stays a 400. The statuses have to differ: reporting an
   * oversized body as "not valid JSON" sends an operator looking for a syntax
   * error in a payload that was never parsed.
   */
  it("keeps a malformed body at 400", async () => {
    const res = await post("/runs", "{not json");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("body: not valid JSON");
  });

  it("still accepts a body under the cap", async () => {
    // Rejected on the mode, which means it got past the read and the parse.
    const res = await post("/runs", JSON.stringify({ goalId: "1", mode: "no-such-goal" }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/^mode: expected one of/);
  });
});
