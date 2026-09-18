import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEMO_GOALS, MOCK_GOALS, SEARCH_TIERS, findDemoGoal, isMockGoal } from "@ntux402/shared";
import type { Address } from "viem";

import { createOrchestratorServer, resourceUrlFor } from "./server.js";
import type { PaymentLoop } from "./pay/payment-loop.js";
import type { SignerClient } from "./pay/signer-client.js";
import type { VaultRelay } from "./pay/relay.js";

const MOCK = "http://mock.test";
const VENDOR = "http://vendor.test";

const urlFor = (mode: string, extra: Record<string, string | undefined> = {}) =>
  resourceUrlFor({ mode, mockApiUrl: MOCK, vendorSearchUrl: VENDOR, ...extra });

describe("resourceUrlFor", () => {
  it("sends mock-served goals to the mock vendor", () => {
    for (const goal of MOCK_GOALS) {
      expect(urlFor(goal.key), goal.key).toBe(`${MOCK}/resource/${goal.key}`);
    }
  });

  it("sends upstream goals to the search vendor, never the mock", () => {
    const live = DEMO_GOALS.filter((g) => g.upstream !== undefined);
    expect(live.length).toBeGreaterThan(0);

    for (const goal of live) {
      const url = urlFor(goal.key);
      expect(url, goal.key).toContain(`${VENDOR}/resource/search`);
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
    const goal = findDemoGoal("search-deep");
    const url = new URL(urlFor("search-deep"));
    expect(url.searchParams.get("tier")).toBe("deep");
    expect(url.searchParams.get("q")).toBe(goal?.upstream?.defaultQuery);
  });

  it("prefers an explicit query over the default", () => {
    const url = new URL(urlFor("search-basic", { query: "what is x402" }));
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
    const raw = urlFor("search-basic", { query: nasty });

    // Exactly one `?`, and the tier is still the goal's own.
    expect(raw.split("?")).toHaveLength(2);
    const url = new URL(raw);
    expect(url.searchParams.get("q")).toBe(nasty);
    expect(url.searchParams.get("tier")).toBe("basic");
    expect(url.pathname).toBe("/resource/search");
  });

  it("honours the price override only on the mock path", () => {
    expect(urlFor("compliance-audit", { priceAtomic: "350000" })).toBe(
      `${MOCK}/resource/compliance-audit?price=350000`,
    );
    // The live vendor prices from the tier table; a caller cannot retune it.
    expect(urlFor("search-basic", { priceAtomic: "999" })).not.toContain("999");
  });

  it("quotes each live goal at its measured tier price", () => {
    expect(findDemoGoal("search-basic")?.priceAtomic).toBe(SEARCH_TIERS.basic.priceAtomic);
    expect(findDemoGoal("search-deep")?.priceAtomic).toBe(SEARCH_TIERS.deep.priceAtomic);
  });
});

/*
 * The HTTP surface, over a real socket.
 *
 * Both groups below need the real `node:http` server rather than the handler.
 * The body cap lives in the read loop, so a test calling the handler directly
 * would never exercise it. The trace guards read headers and `process.env` per
 * request, so they want a real request too.
 */
describe("the orchestrator server", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createOrchestratorServer({
      // Never reached: every case below is refused before a run starts.
      loop: { fetchPaid: async () => ({ kind: "failed", reason: "unreached" }) } as unknown as PaymentLoop,
      relay: { relayAddress: `0x${"11".repeat(20)}` as Address } as unknown as VaultRelay,
      // Same reasoning as `loop`: the body cap rejects before any mint.
      signer: { mintPayer: async () => `0x${"44".repeat(20)}` } as unknown as SignerClient,
      vaultAddress: `0x${"22".repeat(20)}`,
      usdcAddress: `0x${"33".repeat(20)}`,
      chainId: 84532,
      mockApiUrl: "http://mock.test",
      vendorSearchUrl: undefined,
      vendorSearchPayee: undefined,
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

  /*
   * The signer and the facilitator both capped their bodies and this service
   * did not, which made it the cheapest of the three to push over with a large
   * one.
   */
  describe("request bodies", () => {
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

  /*
   * `GET /traces/:goalId` was the one route that answered without asking
   * anything. Goal ids are small sequential integers, so it was a walkable
   * index of every run the process had recorded — the model's reasoning, the
   * vendor's prose, the payees and the amounts.
   *
   * These drive the real server because both controls read `process.env` on
   * every request, which is what lets a deployment be reconfigured without a
   * restart and what lets these cases flip it between assertions.
   *
   * A 404 is the pass condition throughout: the store is empty, so reaching it
   * at all is proof the request got past both guards. The distinction being
   * tested is "refused" against "served", never the trace body.
   */
  describe("GET /traces/:goalId", () => {
    afterEach(() => {
      delete process.env["BIND_HOST"];
      delete process.env["SERVICE_TOKEN"];
    });

    const get = (headers: Record<string, string> = {}) =>
      fetch(`${base}/traces/1`, { headers });

    it("serves on the default loopback bind, as it always did", async () => {
      const res = await get();
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toMatch(/no trace recorded/);
    });

    it("refuses when bound to the network with no token", async () => {
      process.env["BIND_HOST"] = "0.0.0.0";
      const res = await get();
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toMatch(/SERVICE_TOKEN/);
    });

    /*
     * 403 and not 401. There is no credential that would work — the operator
     * configured none — so inviting one would send the caller looking for a
     * token that does not exist.
     */
    it("does not invite a credential it cannot accept", async () => {
      process.env["BIND_HOST"] = "0.0.0.0";
      const res = await get();
      expect(res.headers.get("www-authenticate")).toBeNull();
    });

    it("asks for the bearer once one is configured", async () => {
      process.env["BIND_HOST"] = "0.0.0.0";
      process.env["SERVICE_TOKEN"] = "s3cret";

      const missing = await get();
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toBe("Bearer");

      const wrong = await get({ authorization: "Bearer nope123" });
      expect(wrong.status).toBe(401);

      const right = await get({ authorization: "Bearer s3cret" });
      expect(right.status).toBe(404);
    });

    /*
     * The token binds on loopback too. It would be a strange guard that only
     * applied to the deployment that already had one, and an operator who sets
     * a token has said what they want.
     */
    it("still requires the bearer on loopback when one is set", async () => {
      process.env["SERVICE_TOKEN"] = "s3cret";
      expect((await get()).status).toBe(401);
      expect((await get({ authorization: "Bearer s3cret" })).status).toBe(404);
    });

    /*
     * `/health` and `/config` stay open on purpose: a liveness probe that needs
     * a credential reports the credential, and every address in `/config` is
     * already public on chain. Pinned so that tightening the trace route does
     * not quietly take the probes with it.
     */
    it("leaves the two open probes open", async () => {
      process.env["BIND_HOST"] = "0.0.0.0";
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/config`)).status).toBe(200);
    });
  });
});
