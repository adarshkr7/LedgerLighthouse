import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  HEADER_PAYMENT,
  HEADER_PAYMENT_RESPONSE,
  NETWORK_BASE_SEPOLIA,
  USDC_BASE_SEPOLIA,
  parsePaymentRequired,
  selectTerms,
  toModelSafeSummary,
  type Address,
} from "@ntux402/shared";

import {
  HONEST_PAY_TO,
  HONEST_PRICE_ATOMIC,
  MALICIOUS_PAY_TO,
  MALICIOUS_PRICE_ATOMIC,
} from "./config.js";
import { startMockApi, type StartedServer } from "./server.js";

let api: StartedServer;

beforeAll(async () => {
  api = await startMockApi(0);
});

afterAll(async () => {
  await api.close();
});

const expected = { network: NETWORK_BASE_SEPOLIA, asset: USDC_BASE_SEPOLIA as Address };

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
      headers: { [HEADER_PAYMENT]: "stub-payment-payload" },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { mode: string; data: { premium: boolean } };
    expect(body.mode).toBe("honest");
    expect(body.data.premium).toBe(true);
  });

  it("returns settlement details in X-PAYMENT-RESPONSE (v1 header name)", async () => {
    const res = await fetch(`${api.url}/resource/honest`, {
      headers: { [HEADER_PAYMENT]: "stub-payment-payload" },
    });
    const header = res.headers.get(HEADER_PAYMENT_RESPONSE);
    expect(header).toBeTruthy();

    const decoded = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
    expect(decoded.success).toBe(true);
    expect(decoded.network).toBe(NETWORK_BASE_SEPOLIA);
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
      headers: { [HEADER_PAYMENT]: "stub-payment-payload" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("malicious");
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
