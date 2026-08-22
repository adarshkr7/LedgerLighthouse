import { describe, expect, it } from "vitest";

import {
  HEADER_PAYMENT,
  HEADER_PAYMENT_RESPONSE,
  NETWORK_BASE_SEPOLIA,
  SCHEME_EXACT,
  SEARCH_TIERS,
  X402_VERSION,
  decodeSettlementHeader,
  encodePaymentHeader,
  parsePaymentRequired,
  type Address,
  type PaymentPayload,
  type SearchTier,
  type SettleResponse,
  type VerifyResponse,
} from "@ntux402/shared";

import { handleRequest, type HandlerOptions } from "./handler.js";
import type { PaymentGateway } from "./gateway.js";
import { SpendLedger, type UpstreamResult, type UpstreamSearch } from "./upstream.js";

const PAYEE = "0x4444444444444444444444444444444444444444" as Address;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const PAYER = "0x9999999999999999999999999999999999999999" as Address;

const TAVILY_BODY = {
  query: "base sepolia usdc",
  results: [{ title: "USDC on Base Sepolia", url: "https://example.test", content: "…", score: 1 }],
  usage: { credits: 1 },
  request_id: "req-abc",
};

/** Records every call so a test can assert something was *not* reached. */
class SpyUpstream implements UpstreamSearch {
  calls: Array<{ query: string; tier: SearchTier }> = [];
  constructor(private readonly result: UpstreamResult) {}
  async search(query: string, tier: SearchTier): Promise<UpstreamResult> {
    this.calls.push({ query, tier });
    return this.result;
  }
}

class SpyGateway implements PaymentGateway {
  verifyCalls = 0;
  settleCalls = 0;
  constructor(
    private readonly verifyResult: VerifyResponse,
    private readonly settleResult: SettleResponse = { success: true, transaction: "0xabc" },
  ) {}
  async verify(): Promise<VerifyResponse> {
    this.verifyCalls++;
    return this.verifyResult;
  }
  async settle(): Promise<SettleResponse> {
    this.settleCalls++;
    return this.settleResult;
  }
}

const okUpstream = () =>
  new SpyUpstream({
    ok: true,
    body: TAVILY_BODY,
    costAtomic: "8000",
    requestId: "req-abc",
    latencyMs: 3600,
  });

function paymentHeader(overrides: Partial<{ to: Address; value: string; network: string }> = {}) {
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: SCHEME_EXACT,
    network: overrides.network ?? NETWORK_BASE_SEPOLIA,
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: overrides.to ?? PAYEE,
        value: overrides.value ?? SEARCH_TIERS.basic.priceAtomic,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"22".repeat(32)}`,
      },
    },
  };
  return encodePaymentHeader(payload);
}

const base = (options: Partial<HandlerOptions> = {}): HandlerOptions => ({
  upstream: okUpstream(),
  payTo: PAYEE,
  asset: ASSET,
  baseUrl: "https://vendor.test",
  ...options,
});

const SEARCH = "/resource/aisa/search?q=base%20sepolia%20usdc&tier=basic";

const get = (path: string, headers: Record<string, string> = {}) =>
  handleRequest({ method: "GET", path, headers }, base());

describe("routing and validation", () => {
  it("404s an unknown path and 405s a non-GET", async () => {
    expect((await get("/resource/aisa/nope")).status).toBe(404);
    expect(
      (await handleRequest({ method: "POST", path: SEARCH, headers: {} }, base())).status,
    ).toBe(405);
  });

  it("reports health with the ledger state", async () => {
    const ledger = new SpendLedger({ capAtomic: "1000000" });
    const res = await handleRequest({ method: "GET", path: "/health", headers: {} }, base({ ledger }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, settlement: "stub", capAtomic: "1000000" });
  });

  /*
   * A malformed request is a 400, never a 402. Quoting a price for something we
   * would refuse for free invites the caller to pay for a refusal.
   */
  it("400s a bad query or tier without quoting a price", async () => {
    const long = `q=${"a".repeat(300)}`;
    expect((await get(`/resource/aisa/search?${long}`)).status).toBe(400);
    expect((await get("/resource/aisa/search?q=")).status).toBe(400);
    expect((await get("/resource/aisa/search?q=hi&tier=free")).status).toBe(400);
  });
});

describe("the 402", () => {
  it("is a shape the client's own parser accepts", async () => {
    const res = await get(SEARCH);
    expect(res.status).toBe(402);

    const parsed = parsePaymentRequired(res.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const terms = parsed.value.accepts[0];
    expect(terms?.amount).toBe(BigInt(SEARCH_TIERS.basic.priceAtomic));
    expect(terms?.payTo).toBe(PAYEE);
    // The query is part of what is being bought, so it is part of the resource.
    expect(terms?.resource).toContain("q=base+sepolia+usdc");
  });

  it("prices the deep tier higher than the basic one", async () => {
    const deep = await get("/resource/aisa/search?q=hi&tier=deep");
    const parsed = parsePaymentRequired(deep.body);
    expect(parsed.ok && parsed.value.accepts[0]?.amount).toBe(
      BigInt(SEARCH_TIERS.deep.priceAtomic),
    );
  });
});

describe("the paid path", () => {
  it("verifies, calls upstream, settles, and returns the real payload", async () => {
    const upstream = okUpstream();
    const gateway = new SpyGateway({ isValid: true });
    const res = await handleRequest(
      { method: "GET", path: SEARCH, headers: { [HEADER_PAYMENT]: paymentHeader() } },
      base({ upstream, gateway }),
    );

    expect(res.status).toBe(200);
    expect(gateway.verifyCalls).toBe(1);
    expect(gateway.settleCalls).toBe(1);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.query).toBe("base sepolia usdc");

    const body = res.body as { data: unknown; upstream: { costAtomic?: string } };
    expect(body.data).toEqual(TAVILY_BODY);
    // Cost and quote both reported, so the trace can compare them.
    expect(body.upstream.costAtomic).toBe("8000");

    const settled = decodeSettlementHeader(res.headers[HEADER_PAYMENT_RESPONSE] as string);
    expect(settled.ok && settled.value.success).toBe(true);
  });

  it("passes the tier's depth upstream, never the caller's", async () => {
    const upstream = okUpstream();
    await handleRequest(
      {
        method: "GET",
        path: "/resource/aisa/search?q=hi&tier=deep&search_depth=advanced&max_results=99",
        headers: { [HEADER_PAYMENT]: paymentHeader({ value: SEARCH_TIERS.deep.priceAtomic }) },
      },
      base({ upstream, gateway: new SpyGateway({ isValid: true }) }),
    );
    expect(upstream.calls[0]?.tier.searchDepth).toBe("advanced");
    expect(upstream.calls[0]?.tier.maxResults).toBe(SEARCH_TIERS.deep.maxResults);
  });
});

describe("what must not cost us money", () => {
  /*
   * The griefing case `/verify` exists to close: a well-formed authorization
   * that will fail at settlement. Without the verify step we would pay AIsa for
   * a search before discovering it, and a loop of these drains the vendor's
   * balance for free.
   */
  it("does not call upstream when the facilitator rejects the payment", async () => {
    const upstream = okUpstream();
    const gateway = new SpyGateway({ isValid: false, invalidReason: "nonce already used" });

    const res = await handleRequest(
      { method: "GET", path: SEARCH, headers: { [HEADER_PAYMENT]: paymentHeader() } },
      base({ upstream, gateway }),
    );

    expect(res.status).toBe(402);
    expect(upstream.calls).toHaveLength(0);
    expect(gateway.settleCalls).toBe(0);
    expect(JSON.stringify(res.body)).toContain("nonce already used");
  });

  it("does not call upstream for a wrong payee or a short payment", async () => {
    const wrongPayee = okUpstream();
    expect(
      (
        await handleRequest(
          {
            method: "GET",
            path: SEARCH,
            headers: { [HEADER_PAYMENT]: paymentHeader({ to: PAYER }) },
          },
          base({ upstream: wrongPayee, gateway: new SpyGateway({ isValid: true }) }),
        )
      ).status,
    ).toBe(402);
    expect(wrongPayee.calls).toHaveLength(0);

    const short = okUpstream();
    expect(
      (
        await handleRequest(
          {
            method: "GET",
            path: SEARCH,
            headers: { [HEADER_PAYMENT]: paymentHeader({ value: "1" }) },
          },
          base({ upstream: short, gateway: new SpyGateway({ isValid: true }) }),
        )
      ).status,
    ).toBe(402);
    expect(short.calls).toHaveLength(0);
  });

  it("refuses with 429 once the spend ceiling is reached, before quoting", async () => {
    // Cap below one basic call, so the very first request is over.
    const ledger = new SpendLedger({ capAtomic: "1" });
    const upstream = okUpstream();

    const res = await handleRequest(
      { method: "GET", path: SEARCH, headers: { [HEADER_PAYMENT]: paymentHeader() } },
      base({ upstream, ledger, gateway: new SpyGateway({ isValid: true }) }),
    );

    // 429 not 5xx: the x402 client retries 5xx with backoff, and retrying a
    // ceiling breach is how a bounded overspend becomes an unbounded one.
    expect(res.status).toBe(429);
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("when the upstream fails after a good payment", () => {
  it("returns 502 and settles nothing", async () => {
    const upstream = new SpyUpstream({ ok: false, status: 503, error: "tavily unavailable" });
    const gateway = new SpyGateway({ isValid: true });

    const res = await handleRequest(
      { method: "GET", path: SEARCH, headers: { [HEADER_PAYMENT]: paymentHeader() } },
      base({ upstream, gateway }),
    );

    /*
     * Not a 402. The payment verified moments ago, and "payment required" would
     * send the buyer to diagnose a settlement problem that does not exist. The
     * money must not move: there is nothing to sell them.
     */
    expect(res.status).toBe(502);
    expect(gateway.settleCalls).toBe(0);
    expect(res.headers[HEADER_PAYMENT_RESPONSE]).toBeUndefined();
  });

  it("returns 402 when settlement itself fails, after the upstream succeeded", async () => {
    const gateway = new SpyGateway(
      { isValid: true },
      { success: false, errorReason: "payer has no USDC" },
    );
    const res = await handleRequest(
      { method: "GET", path: SEARCH, headers: { [HEADER_PAYMENT]: paymentHeader() } },
      base({ gateway }),
    );

    expect(res.status).toBe(402);
    expect(JSON.stringify(res.body)).toContain("payer has no USDC");
  });
});
