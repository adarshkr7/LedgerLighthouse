import { describe, expect, it } from "vitest";

import { SEARCH_TIERS } from "@ntux402/shared";

import { GatewaySearch } from "./upstream.js";

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
