import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SEARCH_TIERS } from "@ntux402/shared";

import { GatewaySearch, SpendLedger } from "./upstream.js";

const BODY = { results: [], usage: { credits: 1 }, request_id: "req-1" };

/*
 * A provider-specific header name, supplied as config rather than imported as a
 * constant. That is the point: the client reads whatever header it is told to,
 * so the test names one of its own invention to prove no name is baked in.
 */
const COST_HEADER = "x-example-cost-micros-usd";

/** Every case below needs a base URL — there is deliberately no default. */
const BASE = "https://api.test";

function stubFetch(
  init: { status?: number; body?: unknown; headers?: Record<string, string>; throws?: string } = {},
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    if (init.throws) throw new Error(init.throws);
    return new Response(JSON.stringify(init.body ?? BODY), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("GatewaySearch", () => {
  it("POSTs to the Tavily route with the tier's parameters", async () => {
    const { impl, calls } = stubFetch({ headers: { [COST_HEADER]: "8000" } });
    const client = new GatewaySearch({ apiKey: "k", baseUrl: BASE, costHeader: COST_HEADER, fetchImpl: impl });

    const result = await client.search("usdc on base", SEARCH_TIERS.deep);

    expect(calls[0]?.url).toBe(`${BASE}/apis/v1/tavily/search`);
    expect(calls[0]?.init.method).toBe("POST");

    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent).toMatchObject({
      query: "usdc on base",
      search_depth: "advanced",
      max_results: SEARCH_TIERS.deep.maxResults,
      include_usage: true,
    });

    expect(result.ok && result.costAtomic).toBe("8000");
    expect(result.ok && result.requestId).toBe("req-1");
  });

  /*
   * Micros USD and USDC atomic units are both millionths, so the header value
   * is used as an amount with no conversion. A test pins that, because a stray
   * divide-by-1e6 here would silently under-report every cost.
   */
  it("treats the cost header as an atomic amount verbatim", async () => {
    const { impl } = stubFetch({ headers: { [COST_HEADER]: "16000" } });
    const client = new GatewaySearch({ apiKey: "k", baseUrl: BASE, costHeader: COST_HEADER, fetchImpl: impl });
    const result = await client.search("q", SEARCH_TIERS.deep);
    expect(result.ok && result.costAtomic).toBe("16000");
  });

  it("survives a missing or malformed cost header", async () => {
    for (const headers of [{}, { [COST_HEADER]: "not-a-number" }]) {
      const { impl } = stubFetch({ headers });
      const client = new GatewaySearch({ apiKey: "k", baseUrl: BASE, costHeader: COST_HEADER, fetchImpl: impl });
      const result = await client.search("q", SEARCH_TIERS.basic);
      // Undocumented headers are read defensively: the call still succeeds.
      expect(result.ok).toBe(true);
      expect(result.ok && result.costAtomic).toBeUndefined();
    }
  });

  it("reports no cost when no header is configured", async () => {
    const { impl } = stubFetch({ headers: { [COST_HEADER]: "8000" } });
    const client = new GatewaySearch({ apiKey: "k", baseUrl: BASE, fetchImpl: impl });
    const result = await client.search("q", SEARCH_TIERS.basic);
    // The figure is on the wire; nothing told us to look for it, so it is not
    // ours to read. Reconciliation is off, and the trace says so.
    expect(result.ok).toBe(true);
    expect(result.ok && result.costAtomic).toBeUndefined();
    expect(result.ok && result.costHeader).toBeUndefined();
  });

  it("reports an upstream error status rather than throwing", async () => {
    const { impl } = stubFetch({ status: 429, body: { error: "rate limited" } });
    const client = new GatewaySearch({ apiKey: "k", baseUrl: BASE, costHeader: COST_HEADER, fetchImpl: impl });
    const result = await client.search("q", SEARCH_TIERS.basic);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(429);
  });

  it("reports a transport failure as status 0", async () => {
    const { impl } = stubFetch({ throws: "ECONNREFUSED" });
    const client = new GatewaySearch({ apiKey: "k", baseUrl: BASE, costHeader: COST_HEADER, fetchImpl: impl });
    const result = await client.search("q", SEARCH_TIERS.basic);
    expect(!result.ok && result.status).toBe(0);
  });

  it("sends the key as a bearer token and nowhere else", async () => {
    const { impl, calls } = stubFetch();
    const client = new GatewaySearch({ apiKey: "secret-key", baseUrl: BASE, fetchImpl: impl });
    await client.search("q", SEARCH_TIERS.basic);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer secret-key");
    expect(calls[0]?.url).not.toContain("secret-key");
    expect(String(calls[0]?.init.body)).not.toContain("secret-key");
  });
});

describe("SpendLedger", () => {
  it("permits spending up to the cap and refuses past it", () => {
    const ledger = new SpendLedger({ capAtomic: "20000" });
    expect(ledger.wouldExceed("10000")).toBe(false);
    ledger.record("8000", "10000");
    expect(ledger.wouldExceed("10000")).toBe(false);
    ledger.record("8000", "10000");
    // 16000 spent; another 10000 would breach 20000.
    expect(ledger.wouldExceed("10000")).toBe(true);
  });

  /*
   * An unreported cost counts at the quoted price. Treating it as zero would
   * make a missing header the cheapest way past the ceiling.
   */
  it("charges the quoted price when the real cost is unknown", () => {
    const ledger = new SpendLedger({ capAtomic: "20000" });
    ledger.record(undefined, "10000");
    expect(ledger.spentAtomic).toBe("10000");
  });

  it("resets when the window rolls over", () => {
    let now = 0;
    const ledger = new SpendLedger({ capAtomic: "10000", windowMs: 1000, now: () => now });
    ledger.record("10000", "10000");
    expect(ledger.wouldExceed("1")).toBe(true);

    now = 1001;
    expect(ledger.wouldExceed("1")).toBe(false);
    expect(ledger.spentAtomic).toBe("0");
  });
});

describe("SpendLedger persistence", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "ll-ledger-")), "ledger.json");

  /*
   * The loophole this closes: an in-memory ceiling makes restarting the
   * cheapest way past it, and a service that crash-loops under load does that
   * to itself. Unbounded spend against a real balance, with nobody doing
   * anything wrong.
   */
  it("survives a restart", () => {
    const path = tmp();
    const first = new SpendLedger({ capAtomic: "20000", path });
    first.record("16000", "20000");
    expect(first.wouldExceed("10000")).toBe(true);

    const reopened = new SpendLedger({ capAtomic: "20000", path });
    expect(reopened.spentAtomic).toBe("16000");
    expect(reopened.wouldExceed("10000")).toBe(true);
  });

  it("carries the window across, so a restart does not extend it", () => {
    const path = tmp();
    let now = 1_000_000;
    const first = new SpendLedger({ capAtomic: "10000", windowMs: 1000, path, now: () => now });
    first.record("10000", "10000");

    // Past the window: the reopened ledger must roll, not resume.
    now = 1_002_000;
    const reopened = new SpendLedger({ capAtomic: "10000", windowMs: 1000, path, now: () => now });
    expect(reopened.wouldExceed("1")).toBe(false);
    expect(reopened.spentAtomic).toBe("0");
  });

  it("starts fresh rather than refusing when the file is unreadable", () => {
    const path = tmp();
    writeFileSync(path, "{ not json");
    const ledger = new SpendLedger({ capAtomic: "20000", path });
    // A ledger that cannot be read is a reason to be careful, not to stop
    // selling — the provider-side spending cap is the backstop.
    expect(ledger.spentAtomic).toBe("0");
  });

  it("ignores a ledger whose window starts in the future", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ spentAtomic: "9999", windowStart: Date.now() + 86_400_000 }));
    // A clock change, not a ledger. Honouring it would suppress the ceiling.
    expect(new SpendLedger({ capAtomic: "20000", path }).spentAtomic).toBe("0");
  });

  it("ignores a malformed amount", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ spentAtomic: 9999, windowStart: Date.now() - 10 }));
    expect(new SpendLedger({ capAtomic: "20000", path }).spentAtomic).toBe("0");
  });
});
