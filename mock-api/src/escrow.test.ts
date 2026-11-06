import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_CAPTURE_ESCROW,
  ERC3009_TOKEN_COLLECTOR,
  USDC_BASE_SEPOLIA,
  decodePaymentRequiredHeader,
  decodeSettlementHeader,
  encodePaymentSignatureHeader,
  paymentSalt,
  saltToHex,
  type Address,
  type AuthCapturePayload,
  type AuthCaptureRequirements,
  type SettleResponse,
} from "@ntux402/shared";

import type { ClaimOutcome, EscrowVendorOptions } from "./escrow.js";
import { handleRequest } from "./handler.js";

const VAULT: Address = "0x00000000000000000000000000000000000ab0b1";
const OTHER: Address = "0x00000000000000000000000000000000000ab0b2";
const VENDOR: Address = "0x0000000000000000000000000000000000007e57";
const PAYER: Address = "0x00000000000000000000000000000000000b0b0b";
const NOW = 1_800_000_000;
const PRICE = "10000"; // market-data

class FakeGateway {
  hold: SettleResponse = { success: true, transaction: `0x${"99".repeat(32)}`, network: "eip155:84532" };
  claimResult: ClaimOutcome = { ok: true, transaction: `0x${"88".repeat(32)}` };
  settled: AuthCaptureRequirements[] = [];
  claims: { goalId: bigint; seq: bigint }[] = [];

  async settle(_payment: AuthCapturePayload, requirements: AuthCaptureRequirements) {
    this.settled.push(requirements);
    return this.hold;
  }
  async claim(goalId: bigint, seq: bigint) {
    this.claims.push({ goalId, seq });
    return this.claimResult;
  }
}

describe("the mock vendor selling through the escrow", () => {
  let gateway: FakeGateway;
  let options: EscrowVendorOptions;

  beforeEach(() => {
    gateway = new FakeGateway();
    options = {
      vault: VAULT,
      vendor: VENDOR,
      network: "eip155:84532",
      asset: USDC_BASE_SEPOLIA,
      maxTimeoutSeconds: 60,
      gateway,
      now: () => NOW,
    };
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    handleRequest({ method: "GET", path, headers }, { escrow: options });

  async function quote(path = "/resource/market-data") {
    const response = await get(path);
    expect(response.status).toBe(402);
    const decoded = decodePaymentRequiredHeader(response.headers["PAYMENT-REQUIRED"]!);
    if (!decoded.ok) throw new Error(decoded.error);
    return decoded.value;
  }

  const pay = (accepted: AuthCaptureRequirements): string =>
    encodePaymentSignatureHeader({
      x402Version: 2,
      accepted,
      payload: {
        authorization: {
          from: PAYER,
          to: ERC3009_TOKEN_COLLECTOR,
          value: accepted.amount,
          validAfter: "0",
          validBefore: String(NOW + 60),
          nonce: `0x${"ab".repeat(32)}`,
        },
        signature: `0x${"cd".repeat(65)}`,
        salt: saltToHex(paymentSalt(7n, 3n)),
      },
    });

  it("offers the vault as operator, paying this vendor, in the one profile the buyer accepts", async () => {
    const parsed = await quote();
    const offer = parsed.accepts[0]!;
    expect(offer.payTo).toBe(VENDOR);
    expect(offer.amount).toBe(PRICE);
    expect(offer.extra.captureAuthorizer).toBe(VAULT);
    expect(offer.extra.authCaptureEscrow).toBe(AUTH_CAPTURE_ESCROW);
    expect(offer.extra.captureDeadline).toBeGreaterThan(NOW + 60);
    expect(parsed.resource.url).toContain("/resource/market-data");
  });

  it("pays every catalog entry to this vendor, since only it can claim", async () => {
    for (const path of ["/resource/market-data", "/resource/compliance-audit", "/resource/premium-feed"]) {
      expect((await quote(path)).accepts[0]!.payTo).toBe(VENDOR);
    }
  });

  it("carries the injection in the description, where the buyer's agent will read it", async () => {
    expect((await quote("/resource/premium-feed")).resource.description).toMatch(/SYSTEM NOTICE|pre-approved/i);
  });

  it("holds, then claims, then delivers", async () => {
    const offer = (await quote()).accepts[0]!;
    const response = await get("/resource/market-data", { "payment-signature": pay(offer) });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: { premium: true } });
    expect(gateway.settled).toHaveLength(1);
    expect(gateway.claims).toEqual([{ goalId: 7n, seq: 3n }]);

    const settlement = decodeSettlementHeader(response.headers["PAYMENT-RESPONSE"]!);
    if (!settlement.ok) throw new Error(settlement.error);
    expect(settlement.value.claimTransaction).toBe(`0x${"88".repeat(32)}`);
  });

  /** Retried with the same payment, and the facilitator reports it as already held. */
  it("does not deliver when the claim fails, and answers so the buyer's client retries", async () => {
    gateway.claimResult = { ok: false, reason: "out of gas" };
    const offer = (await quote()).accepts[0]!;
    const response = await get("/resource/market-data", { "payment-signature": pay(offer) });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain("premium");
  });

  it("does not claim or deliver when the hold fails", async () => {
    gateway.hold = { success: false, errorReason: "payer underfunded" };
    const offer = (await quote()).accepts[0]!;
    const response = await get("/resource/market-data", { "payment-signature": pay(offer) });
    expect(response.status).toBe(402);
    expect(gateway.claims).toHaveLength(0);
    const parsed = decodePaymentRequiredHeader(response.headers["PAYMENT-REQUIRED"]!);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.error).toContain("payer underfunded");
  });

  describe("refuses a payment it would not have offered, before placing a hold", () => {
    const cases: [string, (o: AuthCaptureRequirements) => AuthCaptureRequirements][] = [
      ["a lower price", (o) => ({ ...o, amount: "1" })],
      ["another payee", (o) => ({ ...o, payTo: PAYER })],
      ["another token", (o) => ({ ...o, asset: PAYER })],
      ["another network", (o) => ({ ...o, network: "eip155:8453" })],
      ["another operator", (o) => ({ ...o, extra: { ...o.extra, captureAuthorizer: OTHER } })],
      [
        "a deadline already gone",
        (o) => ({ ...o, extra: { ...o.extra, captureDeadline: NOW, refundDeadline: NOW } }),
      ],
      [
        "a deadline later than offered",
        (o) => ({ ...o, extra: { ...o.extra, captureDeadline: NOW + 99_999, refundDeadline: NOW + 99_999 } }),
      ],
    ];
    it.each(cases)("%s", async (_name, change) => {
      const offer = (await quote()).accepts[0]!;
      const response = await get("/resource/market-data", { "payment-signature": pay(change(offer)) });
      expect(response.status).toBe(402);
      expect(gateway.settled).toHaveLength(0);
      expect(gateway.claims).toHaveLength(0);
    });
  });

  it("refuses a garbled header without placing a hold", async () => {
    const response = await get("/resource/market-data", { "payment-signature": "not base64 json" });
    expect(response.status).toBe(402);
    expect(gateway.settled).toHaveLength(0);
  });

  it("reports itself as an escrow vendor on /health", async () => {
    const response = await get("/health");
    expect(response.body).toMatchObject({ x402Version: 2, settlement: "escrow", vendor: VENDOR, vault: VAULT });
  });
});
