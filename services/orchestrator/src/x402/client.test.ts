import { afterEach, describe, expect, it } from "vitest";

import {
  HEADER_PAYMENT,
  NETWORK_BASE_SEPOLIA,
  USDC_BASE_SEPOLIA,
} from "@ntux402/shared";

import { InMemoryResponseCache, cacheKey } from "./cache.js";
import { DEFAULT_RETRY, X402Client, backoffDelay } from "./client.js";
import {
  startScriptedServer,
  type ScriptedResponse,
  type ScriptedServer,
} from "./scripted-server.test-helper.js";

let running: ScriptedServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(script: readonly ScriptedResponse[]): Promise<ScriptedServer> {
  running = await startScriptedServer(script);
  return running;
}

function validTermsBody(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: NETWORK_BASE_SEPOLIA,
        maxAmountRequired: "10000",
        asset: USDC_BASE_SEPOLIA,
        payTo: "0x1111111111111111111111111111111111111111",
        resource: "https://api.example.com/resource/honest",
        description: "Premium market data",
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
        ...overrides,
      },
    ],
  };
}

/** Records how long each backoff wait would have been, without waiting. */
function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("200 branch", () => {
  it("returns data and reports it did not come from cache", async () => {
    const api = await serve([{ status: 200, body: { data: "premium" } }]);
    const client = new X402Client();

    const outcome = await client.fetchResource(`${api.url}/r`);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.body).toEqual({ data: "premium" });
    expect(outcome.fromCache).toBe(false);
  });

  it("fails cleanly when a 200 body is not JSON", async () => {
    const api = await serve([{ status: 200, rawBody: "<html>nope</html>" }]);
    const client = new X402Client();

    const outcome = await client.fetchResource(`${api.url}/r`);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason.type).toBe("invalid-json");
  });
});

describe("402 branch — control flow, not an exception", () => {
  it("resolves (never throws) and yields typed terms", async () => {
    const api = await serve([{ status: 402, body: validTermsBody() }]);
    const client = new X402Client();

    const outcome = await client.fetchResource(`${api.url}/r`);
    expect(outcome.kind).toBe("payment-required");
    if (outcome.kind !== "payment-required") return;

    expect(outcome.status).toBe(402);
    expect(outcome.parsed.accepts[0]!.amount).toBe(10_000n);
  });

  it("does not retry a 402 — it is an answer, not a failure", async () => {
    const api = await serve([{ status: 402, body: validTermsBody() }]);
    const client = new X402Client({ retry: { maxAttempts: 4, baseDelayMs: 1, factor: 2 } });

    await client.fetchResource(`${api.url}/r`);
    expect(api.hits).toBe(1);
  });

  it("rejects a malformed 402 rather than coercing it", async () => {
    const api = await serve([
      { status: 402, body: validTermsBody({ maxAmountRequired: 10000 }) }, // number, not string
    ]);
    const client = new X402Client();

    const outcome = await client.fetchResource(`${api.url}/r`);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason.type).toBe("malformed-402");
  });

  it("rejects a v2-shaped 402 — the version is pinned", async () => {
    const api = await serve([{ status: 402, body: { x402Version: 2, accepts: [] } }]);
    const client = new X402Client();

    const outcome = await client.fetchResource(`${api.url}/r`);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason.type).toBe("malformed-402");
  });

  it("does not retry a malformed 402 — retrying cannot make it valid", async () => {
    const api = await serve([{ status: 402, body: { x402Version: 1 } }]);
    const client = new X402Client({ retry: { maxAttempts: 4, baseDelayMs: 1, factor: 2 } });

    await client.fetchResource(`${api.url}/r`);
    expect(api.hits).toBe(1);
  });

  it("never caches a 402 — stale terms must not drive a later payment", async () => {
    const api = await serve([{ status: 402, body: validTermsBody() }]);
    const client = new X402Client();

    await client.fetchResource(`${api.url}/r`);
    expect(client.cache.size).toBe(0);
  });
});

describe("5xx branch — bounded exponential backoff", () => {
  it("retries and succeeds once the server recovers", async () => {
    const api = await serve([
      { status: 503, body: { error: "unavailable" } },
      { status: 503, body: { error: "unavailable" } },
      { status: 200, body: { data: "premium" } },
    ]);
    const { sleep, delays } = recordingSleep();
    const client = new X402Client({ retry: { maxAttempts: 4, baseDelayMs: 100, factor: 2 }, sleep });

    const outcome = await client.fetchResource(`${api.url}/r`);
    expect(outcome.kind).toBe("ok");
    expect(api.hits).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("backs off exponentially", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 250, factor: 2 };
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, policy))).toEqual([250, 500, 1000, 2000]);
  });

  it("gives up after maxAttempts and reports the last status", async () => {
    const api = await serve([{ status: 500, body: { error: "boom" } }]);
    const { sleep, delays } = recordingSleep();
    const client = new X402Client({ retry: { maxAttempts: 3, baseDelayMs: 10, factor: 3 }, sleep });

    const outcome = await client.fetchResource(`${api.url}/r`);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason.type).toBe("retries-exhausted");
    if (outcome.reason.type !== "retries-exhausted") return;

    expect(outcome.reason.attempts).toBe(3);
    expect(outcome.reason.lastStatus).toBe(500);
    expect(api.hits).toBe(3);
    // One fewer sleep than attempts — no point waiting after the last try.
    expect(delays).toEqual([10, 30]);
  });

  it("honours maxAttempts: 1 by not retrying at all", async () => {
    const api = await serve([{ status: 502, body: {} }]);
    const client = new X402Client({ retry: { maxAttempts: 1, baseDelayMs: 1, factor: 2 } });

    await client.fetchResource(`${api.url}/r`);
    expect(api.hits).toBe(1);
  });

  it("retries a transport failure the same way", async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const client = new X402Client({
      retry: { maxAttempts: 3, baseDelayMs: 1, factor: 2 },
      fetchImpl,
      sleep,
    });

    const outcome = await client.fetchResource("http://127.0.0.1:1/r");
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason.type).toBe("retries-exhausted");
    expect(calls).toBe(3);
  });
});

describe("other 4xx", () => {
  it("fails immediately without retrying", async () => {
    const api = await serve([{ status: 404, body: { error: "not found" } }]);
    const client = new X402Client({ retry: { maxAttempts: 4, baseDelayMs: 1, factor: 2 } });

    const outcome = await client.fetchResource(`${api.url}/r`);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason.type).toBe("http-error");
    expect(api.hits).toBe(1);
  });
});

describe("cache prevents re-entering the payment path", () => {
  it("serves a repeat request from cache without touching the network", async () => {
    const api = await serve([{ status: 200, body: { data: "premium" } }]);
    const client = new X402Client();

    const first = await client.fetchResource(`${api.url}/r`);
    const second = await client.fetchResource(`${api.url}/r`);

    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.fromCache).toBe(true);
    expect(second.body).toEqual({ data: "premium" });
    expect(api.hits).toBe(1);
  });

  it("after a paid 200, a retry returns data instead of another 402", async () => {
    // The scenario the cache exists for: pay once, get 200, then the caller
    // retries after a blip. Without the cache the server answers 402 again and
    // the agent pays twice for one resource.
    const api = await serve([
      { status: 402, body: validTermsBody() },
      { status: 200, body: { data: "premium" } },
      { status: 402, body: validTermsBody() }, // server would re-charge
    ]);
    const client = new X402Client();
    const url = `${api.url}/r`;

    const unpaid = await client.fetchResource(url);
    expect(unpaid.kind).toBe("payment-required");

    const paid = await client.fetchResource(url, { payment: "stub-payment-payload" });
    expect(paid.kind).toBe("ok");

    const retry = await client.fetchResource(url);
    expect(retry.kind).toBe("ok");
    if (retry.kind !== "ok") return;
    expect(retry.fromCache).toBe(true);
    expect(api.hits).toBe(2); // the third scripted 402 was never requested
  });

  it("sends X-PAYMENT only when a payment payload is supplied", async () => {
    const api = await serve([
      { status: 402, body: validTermsBody() },
      { status: 200, body: { data: "premium" } },
    ]);
    const client = new X402Client();
    const url = `${api.url}/r`;

    await client.fetchResource(url);
    await client.fetchResource(url, { payment: "stub-payment-payload" });

    expect(api.requests[0]!.headers[HEADER_PAYMENT.toLowerCase()]).toBeUndefined();
    expect(api.requests[1]!.headers[HEADER_PAYMENT.toLowerCase()]).toBe("stub-payment-payload");
  });

  it("keys the cache per URL", async () => {
    const api = await serve([{ status: 200, body: { data: "premium" } }]);
    const client = new X402Client();

    await client.fetchResource(`${api.url}/a`);
    await client.fetchResource(`${api.url}/b`);
    expect(api.hits).toBe(2);
    expect(client.cache.size).toBe(2);
  });

  it("does not cache failures", async () => {
    const api = await serve([{ status: 500, body: {} }]);
    const client = new X402Client({ retry: { maxAttempts: 1, baseDelayMs: 1, factor: 2 } });

    await client.fetchResource(`${api.url}/r`);
    expect(client.cache.size).toBe(0);
  });

  it("expires entries past the TTL", async () => {
    let now = 1_000;
    const cache = new InMemoryResponseCache({ ttlMs: 500, now: () => now });
    const api = await serve([{ status: 200, body: { data: "premium" } }]);
    const client = new X402Client({ cache });
    const url = `${api.url}/r`;

    await client.fetchResource(url);
    now += 501;

    const afterExpiry = await client.fetchResource(url);
    expect(afterExpiry.kind).toBe("ok");
    if (afterExpiry.kind !== "ok") return;
    expect(afterExpiry.fromCache).toBe(false);
    expect(api.hits).toBe(2);
  });

  it("builds keys from method and URL", () => {
    expect(cacheKey("get", "https://x/y")).toBe("GET https://x/y");
  });
});

describe("defaults", () => {
  it("ships a bounded retry policy", () => {
    expect(DEFAULT_RETRY.maxAttempts).toBeGreaterThan(1);
    expect(DEFAULT_RETRY.maxAttempts).toBeLessThanOrEqual(5);
  });
});
