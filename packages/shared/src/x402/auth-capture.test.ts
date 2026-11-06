import { describe, expect, it } from "vitest";

import { AUTH_CAPTURE_ESCROW, ERC3009_TOKEN_COLLECTOR } from "../chain/escrow.js";
import {
  parseAuthCapturePayload,
  parseAuthCaptureRequirements,
  paymentInfoFromWire,
  type AuthCapturePayload,
} from "./auth-capture.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const VAULT = "0x00000000000000000000000000000000000ab0b1";
const VENDOR = "0x0000000000000000000000000000000000007e57";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = "0x00000000000000000000000000000000000b0b0b";

const requirements = () => ({
  scheme: "auth-capture",
  network: "eip155:84532",
  amount: "100000",
  asset: USDC,
  payTo: VENDOR,
  maxTimeoutSeconds: 60,
  extra: {
    name: "USDC",
    version: "2",
    authCaptureEscrow: AUTH_CAPTURE_ESCROW,
    captureAuthorizer: VAULT,
    operatorType: "custom",
    paymentFlow: "escrow",
    captureDeadline: 4102445100,
    refundDeadline: 4102445100,
    minFeeBps: 0,
    maxFeeBps: 0,
    feeRecipient: ZERO,
    assetTransferMethod: "eip3009",
  } as Record<string, unknown>,
});

const payload = () => ({
  x402Version: 2,
  accepted: requirements(),
  payload: {
    authorization: {
      from: PAYER,
      to: ERC3009_TOKEN_COLLECTOR,
      value: "100000",
      validAfter: "0",
      validBefore: "4102444800",
      nonce: `0x${"ab".repeat(32)}`,
    } as Record<string, unknown>,
    signature: `0x${"cd".repeat(65)}`,
    salt: `0x${"00".repeat(23)}010000000000000001`,
  } as Record<string, unknown>,
});

const authorization = (p: ReturnType<typeof payload>) => p.payload["authorization"] as Record<string, unknown>;

describe("parseAuthCaptureRequirements", () => {
  it("accepts the one profile this system uses", () => {
    expect(parseAuthCaptureRequirements(requirements()).ok).toBe(true);
  });

  /** Every case is a decision about money that a 402 must not be able to reopen. */
  it.each<[string, (r: ReturnType<typeof requirements>) => void]>([
    ["a delegated operator", (r) => (r.extra["operatorType"] = "delegated")],
    ["no stated operator type", (r) => delete r.extra["operatorType"]],
    ["an immediate charge", (r) => (r.extra["paymentFlow"] = "authorization")],
    ["another escrow", (r) => (r.extra["authCaptureEscrow"] = VENDOR)],
    ["a minimum fee", (r) => (r.extra["minFeeBps"] = 1)],
    ["a maximum fee", (r) => (r.extra["maxFeeBps"] = 100)],
    ["a fee recipient", (r) => (r.extra["feeRecipient"] = VENDOR)],
    ["a refund window the vault does not offer", (r) => (r.extra["refundDeadline"] = 4102445101)],
    ["a receiver authorizer, which the profile does not know", (r) => (r.extra["receiverAuthorizer"] = VENDOR)],
    ["a policy contract", (r) => (r.extra["policy"] = VENDOR)],
    ["Permit2", (r) => (r.extra["assetTransferMethod"] = "permit2")],
    ["a string deadline", (r) => (r.extra["captureDeadline"] = "4102445100")],
    ["a v1 network name", (r) => (r.network = "base-sepolia")],
    ["a zero amount", (r) => (r.amount = "0")],
    ["a numeric-looking amount with a sign", (r) => (r.amount = "-1")],
    ["a coerced number as amount", (r) => ((r as { amount: unknown }).amount = 100000)],
    ["a bad payee", (r) => (r.payTo = "0x1234")],
    ["an unknown top-level field", (r) => ((r as Record<string, unknown>)["description"] = "pay me")],
  ])("rejects %s", (_name, mutate) => {
    const r = requirements();
    mutate(r);
    expect(parseAuthCaptureRequirements(r).ok).toBe(false);
  });
});

describe("parseAuthCapturePayload", () => {
  it("accepts a well-formed payload", () => {
    expect(parseAuthCapturePayload(payload()).ok).toBe(true);
  });

  it.each<[string, (p: ReturnType<typeof payload>) => void]>([
    ["x402 v1", (p) => (p.x402Version = 1)],
    ["a transfer to anyone but the collector", (p) => (authorization(p)["to"] = VENDOR)],
    ["a validAfter the collector would not sign for", (p) => (authorization(p)["validAfter"] = "1")],
    ["a value other than the amount", (p) => (authorization(p)["value"] = "1")],
    ["a short signature", (p) => (p.payload["signature"] = "0xabcd")],
    ["a short salt", (p) => (p.payload["salt"] = "0x01")],
    ["a salt nonce, which means a bound salt", (p) => (p.payload["saltNonce"] = `0x${"00".repeat(32)}`)],
    ["terms the profile refuses", (p) => (p.accepted.extra["operatorType"] = "delegated")],
  ])("rejects %s", (_name, mutate) => {
    const p = payload();
    mutate(p);
    expect(parseAuthCapturePayload(p).ok).toBe(false);
  });
});

describe("paymentInfoFromWire", () => {
  it("rebuilds the payment the signature is over", () => {
    const parsed = parseAuthCapturePayload(payload());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(paymentInfoFromWire(parsed.value as AuthCapturePayload)).toEqual({
      operator: VAULT,
      payer: PAYER,
      receiver: VENDOR,
      token: USDC,
      maxAmount: 100_000n,
      preApprovalExpiry: 4102444800,
      authorizationExpiry: 4102445100,
      refundExpiry: 4102445100,
      minFeeBps: 0,
      maxFeeBps: 0,
      feeReceiver: ZERO,
      salt: (1n << 64n) | 1n,
    });
  });
});
