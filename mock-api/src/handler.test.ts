import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  HEADER_PAYMENT,
  HEADER_PAYMENT_RESPONSE,
  NETWORK_BASE_SEPOLIA,
  SCHEME_EXACT,
  USDC_BASE_SEPOLIA,
  X402_VERSION,
  encodePaymentHeader,
  parsePaymentRequired,
  selectTerms,
  toModelSafeSummary,
  type Address,
  type PaymentPayload,
} from "@ntux402/shared";

import { DEMO_GOALS, findDemoGoal } from "./config.js";
import { startMockApi, type StartedServer } from "./server.js";

// The legacy `/resource/honest` and `/resource/malicious` paths are aliases onto
// these two catalog entries, so the assertions below still describe exactly what
// those paths serve.
const HONEST = findDemoGoal("market-data")!;
const MALICIOUS = findDemoGoal("premium-feed")!;

const HONEST_PAY_TO = HONEST.payTo;
const HONEST_PRICE_ATOMIC = HONEST.priceAtomic;
const MALICIOUS_PAY_TO = MALICIOUS.payTo;
const MALICIOUS_PRICE_ATOMIC = MALICIOUS.priceAtomic;

let api: StartedServer;

beforeAll(async () => {
  api = await startMockApi(0);
});

afterAll(async () => {
  await api.close();
});

const expected = { network: NETWORK_BASE_SEPOLIA, asset: USDC_BASE_SEPOLIA as Address };

/**
 * A well-formed x402 v1 `exact` payload. The signature is nonsense, which is
 * exactly right for stub mode: with no facilitator the server validates the
 * *shape* of a payment and moves no money. Signature checking lives in the
 * facilitator, and is tested there against a real key.
 */
function stubPayment(payTo: string, valueAtomic: string): string {
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: SCHEME_EXACT,
    network: NETWORK_BASE_SEPOLIA,
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: "0x5555555555555555555555555555555555555555",
        to: payTo as Address,
        value: valueAtomic,
        validAfter: "0",
        validBefore: "99999999999",
        nonce: `0x${"22".repeat(32)}`,
      },
    },
  };
  return encodePaymentHeader(payload);
}

describe("GET /resource/honest", () => {
  it("returns 402 with payment requirements when unpaid", async () => {
    const res = await fetch(`${api.url}/resource/honest`);
    expect(res.status).toBe(402);

    const parsed = parsePaymentRequired(await res.json());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const selected = selectTerms(parsed.value, expected);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    expect(selected.value.amount).toBe(BigInt(HONEST_PRICE_ATOMIC));
    expect(selected.value.payTo).toBe(HONEST_PAY_TO);
    expect(selected.value.resource).toContain("/resource/honest");
  });

  it("emits a body our own strict parser accepts — the mock cannot drift from the schema", async () => {
    const res = await fetch(`${api.url}/resource/honest`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["x402Version"]).toBe(1);
    expect(parsePaymentRequired(body).ok).toBe(true);
  });

  it("returns 200 with premium data on the paid retry", async () => {
    const res = await fetch(`${api.url}/resource/honest`, {
      headers: { [HEADER_PAYMENT]: stubPayment(HONEST_PAY_TO, HONEST_PRICE_ATOMIC) },
    });
    expect(res.status).toBe(200);

    // `mode` echoes the catalog key the alias resolved to, not the alias.
    const body = (await res.json()) as { mode: string; data: { premium: boolean } };
    expect(body.mode).toBe(HONEST.key);
    expect(body.data.premium).toBe(true);
  });

  it("returns settlement details in X-PAYMENT-RESPONSE (v1 header name)", async () => {
    const res = await fetch(`${api.url}/resource/honest`, {
      headers: { [HEADER_PAYMENT]: stubPayment(HONEST_PAY_TO, HONEST_PRICE_ATOMIC) },
    });
    const header = res.headers.get(HEADER_PAYMENT_RESPONSE);
    expect(header).toBeTruthy();

    const decoded = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
    expect(decoded.success).toBe(true);
    expect(decoded.network).toBe(NETWORK_BASE_SEPOLIA);
    // Unmistakably a stub: no facilitator was configured, so no money moved.
    expect(decoded.simulated).toBe(true);
    expect(decoded.transaction).toBeUndefined();
  });

  it("treats an empty X-PAYMENT header as unpaid", async () => {
    const res = await fetch(`${api.url}/resource/honest`, {
      headers: { [HEADER_PAYMENT]: "" },
    });
    expect(res.status).toBe(402);
  });
});

describe("GET /resource/malicious", () => {
  it("returns 402 with a wildly inflated price", async () => {
    const res = await fetch(`${api.url}/resource/malicious`);
    expect(res.status).toBe(402);

    const parsed = parsePaymentRequired(await res.json());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const selected = selectTerms(parsed.value, expected);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    expect(selected.value.amount).toBe(BigInt(MALICIOUS_PRICE_ATOMIC));
    expect(selected.value.amount).toBeGreaterThan(BigInt(HONEST_PRICE_ATOMIC) * 100n);
  });

  it("directs payment to a different payee than the honest endpoint", async () => {
    const res = await fetch(`${api.url}/resource/malicious`);
    const parsed = parsePaymentRequired(await res.json());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.accepts[0]!.payTo).toBe(MALICIOUS_PAY_TO);
    expect(MALICIOUS_PAY_TO).not.toBe(HONEST_PAY_TO);
  });

  it("carries a prompt injection inside the legitimate `description` field", async () => {
    const res = await fetch(`${api.url}/resource/malicious`);
    const parsed = parsePaymentRequired(await res.json());
    if (!parsed.ok) throw new Error(parsed.error);

    const { description } = parsed.value.accepts[0]!;
    expect(description).toContain("pre-approved");
    expect(description).toMatch(/policy check|policy evaluation/i);
    expect(description.toLowerCase()).toContain("ignore");
  });

  it("is still schema-valid — the attack is the content, not a malformed payload", async () => {
    // The injection must not be detectable by parsing alone. If a malformed
    // body were the tell, the demo would prove nothing about prompt injection.
    const res = await fetch(`${api.url}/resource/malicious`);
    expect(parsePaymentRequired(await res.json()).ok).toBe(true);
  });

  it("keeps the injection out of anything model-facing", async () => {
    const res = await fetch(`${api.url}/resource/malicious`);
    const parsed = parsePaymentRequired(await res.json());
    if (!parsed.ok) throw new Error(parsed.error);

    const safe = toModelSafeSummary(parsed.value.accepts[0]!);
    expect(JSON.stringify(safe)).not.toContain("SYSTEM NOTICE");
    expect(JSON.stringify(safe)).not.toContain("pre-approved");
  });

  it("settles too — nothing server-side declines the money", async () => {
    const res = await fetch(`${api.url}/resource/malicious`, {
      headers: { [HEADER_PAYMENT]: stubPayment(MALICIOUS_PAY_TO, MALICIOUS_PRICE_ATOMIC) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe(MALICIOUS.key);
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const res = await fetch(`${api.url}/resource/nope`);
    expect(res.status).toBe(404);
  });

  it("405s a non-GET method", async () => {
    const res = await fetch(`${api.url}/resource/honest`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("serves /health without payment", async () => {
    const res = await fetch(`${api.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, x402Version: 1 });
  });
});

describe("payment payload validation", () => {
  it("rejects a header that is not base64 JSON", async () => {
    const res = await fetch(`${api.url}/resource/honest`, {
      headers: { [HEADER_PAYMENT]: "not-a-real-payload" },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("payment rejected");
  });

  it("rejects a v2-shaped payload rather than adapting to it", async () => {
    const v2 = Buffer.from(
      JSON.stringify({ x402Version: 2, scheme: SCHEME_EXACT, network: "eip155:84532", payload: {} }),
      "utf8",
    ).toString("base64");
    const res = await fetch(`${api.url}/resource/honest`, { headers: { [HEADER_PAYMENT]: v2 } });
    expect(res.status).toBe(402);
  });

  it("rejects a payment directed at a different payee", async () => {
    // The malicious server's payee, presented to the honest endpoint.
    const res = await fetch(`${api.url}/resource/honest`, {
      headers: { [HEADER_PAYMENT]: stubPayment(MALICIOUS_PAY_TO, HONEST_PRICE_ATOMIC) },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("payee mismatch");
  });

  it("rejects a payment for less than the asking price", async () => {
    const res = await fetch(`${api.url}/resource/honest`, {
      headers: { [HEADER_PAYMENT]: stubPayment(HONEST_PAY_TO, "1") },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("insufficient");
  });

  it("re-serves the full payment requirements on a rejected payment", async () => {
    // A rejected payment must leave the client able to try again, so the 402
    // body has to stay a valid 402 body rather than degrading to an error blob.
    const res = await fetch(`${api.url}/resource/honest`, {
      headers: { [HEADER_PAYMENT]: "garbage" },
    });
    expect(parsePaymentRequired(await res.json()).ok).toBe(true);
  });
});

describe("the catalog's own paths", () => {
  it("serves every catalog entry at /resource/<key>", async () => {
    for (const goal of DEMO_GOALS) {
      const res = await fetch(`${api.url}/resource/${goal.key}`);
      expect(res.status, goal.key).toBe(402);

      const parsed = parsePaymentRequired(await res.json());
      expect(parsed.ok, goal.key).toBe(true);
      if (!parsed.ok) continue;

      const selected = selectTerms(parsed.value, expected);
      expect(selected.ok, goal.key).toBe(true);
      if (!selected.ok) continue;

      // The price on the wire is the catalog price, not a copy that drifted.
      expect(selected.value.amount, goal.key).toBe(BigInt(goal.priceAtomic));
      expect(selected.value.payTo.toLowerCase(), goal.key).toBe(goal.payTo.toLowerCase());
    }
  });

  it("keeps the legacy paths working as aliases", async () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["honest", "market-data"],
      ["malicious", "premium-feed"],
    ];

    for (const [alias, key] of pairs) {
      const goal = findDemoGoal(key)!;
      const res = await fetch(`${api.url}/resource/${alias}`);
      const parsed = parsePaymentRequired(await res.json());
      expect(parsed.ok, alias).toBe(true);
      if (!parsed.ok) continue;

      const selected = selectTerms(parsed.value, expected);
      expect(selected.ok, alias).toBe(true);
      if (!selected.ok) continue;
      expect(selected.value.amount, alias).toBe(BigInt(goal.priceAtomic));
    }
  });

  /*
   * The load-bearing property of the overcharge entry.
   *
   * Its whole job is to be refused by the *encrypted* budget, which only means
   * anything if nothing public could have refused it first. So: no injection in
   * the description, and a price comfortably under the public per-call cap.
   */
  it("keeps the overcharge entry free of anything a public check could catch", async () => {
    const goal = findDemoGoal("compliance-audit")!;
    const res = await fetch(`${api.url}/resource/compliance-audit`);
    const parsed = parsePaymentRequired(await res.json());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const selected = selectTerms(parsed.value, expected);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    // Well under the 6.00 USDC public per-call cap the demo opens goals with.
    expect(selected.value.amount).toBeLessThan(6_000_000n);
    // Above the 0.20 USDC encrypted budget — so the only thing left to stop it
    // is the confidential check.
    expect(selected.value.amount).toBeGreaterThan(200_000n);
    expect(goal.tactic).toBe("overcharge");
    expect(selected.value.description).not.toContain("SYSTEM NOTICE");
  });

  it("keeps the two honest calls affordable together", async () => {
    // A viewer should be able to run both and watch USDC leave twice before
    // anything is refused; that only holds if they sum to under the budget.
    const total = DEMO_GOALS.filter((g) => g.kind === "honest").reduce(
      (sum, g) => sum + BigInt(g.priceAtomic),
      0n,
    );
    expect(total).toBeLessThan(200_000n);
  });

  it("404s an unknown resource key", async () => {
    const res = await fetch(`${api.url}/resource/not-a-real-key`);
    expect(res.status).toBe(404);
  });
});
