/**
 * The facilitator's auth-capture route, with the SDK replaced. Whether the real SDK
 * can settle through the real escrow is in auth-capture.fork.test.ts.
 */

import type { AddressInfo } from "node:net";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { AUTH_CAPTURE_ESCROW, ERC3009_TOKEN_COLLECTOR, type AuthCapturePayload } from "@ntux402/shared";

import { AuthCaptureFacilitator, type AuthCaptureConfig, type SettlementScheme } from "./auth-capture.js";
import { Facilitator } from "./facilitator.js";
import { createFacilitatorServer } from "./http.js";

const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const VAULT: Address = "0x00000000000000000000000000000000000ab0b1";
const OTHER_VAULT: Address = "0x00000000000000000000000000000000000ab0b2";
const VENDOR: Address = "0x0000000000000000000000000000000000007e57";
const PAYER: Address = "0x00000000000000000000000000000000000b0b0b";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const SETTLER = generatePrivateKey();
void privateKeyToAccount;

const CONFIG: AuthCaptureConfig = {
  rpcUrl: "http://unused",
  chainId: 84532,
  asset: USDC,
  settlerKey: SETTLER,
  operators: [VAULT],
};

const terms = (operator: Address = VAULT) => ({
  scheme: "auth-capture" as const,
  network: "eip155:84532",
  amount: "100000",
  asset: USDC,
  payTo: VENDOR,
  maxTimeoutSeconds: 60,
  extra: {
    name: "USDC",
    version: "2",
    authCaptureEscrow: AUTH_CAPTURE_ESCROW as Address,
    captureAuthorizer: operator,
    operatorType: "custom" as const,
    paymentFlow: "escrow" as const,
    captureDeadline: 4102445100,
    refundDeadline: 4102445100,
    minFeeBps: 0 as const,
    maxFeeBps: 0 as const,
    feeRecipient: ZERO,
    assetTransferMethod: "eip3009" as const,
  },
});

const payment = (requirements = terms()): AuthCapturePayload => ({
  x402Version: 2,
  accepted: requirements,
  payload: {
    authorization: {
      from: PAYER,
      to: ERC3009_TOKEN_COLLECTOR,
      value: "100000",
      validAfter: "0",
      validBefore: "4102444800",
      nonce: `0x${"ab".repeat(32)}`,
    },
    signature: `0x${"cd".repeat(65)}`,
    salt: `0x${"00".repeat(23)}010000000000000001`,
  },
});

describe("AuthCaptureFacilitator", () => {
  let scheme: { verify: ReturnType<typeof vi.fn>; settle: ReturnType<typeof vi.fn> };
  let collected: boolean;
  let facilitator: AuthCaptureFacilitator;

  beforeEach(() => {
    scheme = {
      verify: vi.fn(async () => ({ isValid: true, payer: PAYER })),
      settle: vi.fn(async () => ({ success: true, transaction: "0xabc" })),
    };
    collected = false;
    facilitator = new AuthCaptureFacilitator(CONFIG, {
      scheme: scheme as unknown as SettlementScheme,
      readCollected: async () => collected,
    });
  });

  it("refuses to run with no operator allowlisted", () => {
    expect(() => new AuthCaptureFacilitator({ ...CONFIG, operators: [] })).toThrow(/at least one operator/);
  });

  it("passes a payment through to the SDK when everything agrees", async () => {
    expect(await facilitator.verify(payment(), terms())).toMatchObject({ isValid: true });
    expect(await facilitator.settle(payment(), terms())).toMatchObject({ success: true, transaction: "0xabc" });
    expect(scheme.settle).toHaveBeenCalledOnce();
  });

  /** A repeat after a lost response. The money moved, so it must not read as a refusal. */
  it("reports a collected payment as settled without sending anything", async () => {
    collected = true;
    expect(await facilitator.settle(payment(), terms())).toMatchObject({ success: true, alreadySettled: true });
    expect(scheme.settle).not.toHaveBeenCalled();
  });

  describe("refuses before the SDK sees it", () => {
    const cases: [string, () => [AuthCapturePayload, ReturnType<typeof terms>]][] = [
      ["an operator not on the allowlist", () => [payment(terms(OTHER_VAULT)), terms(OTHER_VAULT)]],
      ["another token", () => [payment({ ...terms(), asset: VENDOR }), { ...terms(), asset: VENDOR }]],
      ["another network", () => [payment({ ...terms(), network: "eip155:8453" }), { ...terms(), network: "eip155:8453" }]],
      ["terms that differ from the ones accepted", () => [payment(), { ...terms(), amount: "1" }]],
    ];
    it.each(cases)("%s", async (_name, build) => {
      const [p, r] = build();
      expect(await facilitator.verify(p, r)).toMatchObject({ isValid: false });
      expect(await facilitator.settle(p, r)).toMatchObject({ success: false });
      expect(scheme.verify).not.toHaveBeenCalled();
      expect(scheme.settle).not.toHaveBeenCalled();
    });
  });
});

describe("POST /settle with auth-capture", () => {
  const exact = new Facilitator({
    rpcUrl: "http://unused",
    chainId: 84532,
    asset: USDC,
    network: "base-sepolia",
    settlerKey: SETTLER,
  });

  async function call(
    authCapture: AuthCaptureFacilitator | undefined,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const server = createFacilitatorServer({
      facilitator: exact,
      network: "base-sepolia",
      ...(authCapture ? { authCapture } : {}),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const enabled = () =>
    new AuthCaptureFacilitator(CONFIG, {
      scheme: {
        verify: async () => ({ isValid: true }),
        settle: async () => ({ success: true, transaction: "0xabc" }),
      } as unknown as SettlementScheme,
      readCollected: async () => false,
    });

  it("settles through the auth-capture path", async () => {
    const { status, json } = await call(enabled(), "/settle", {
      paymentPayload: payment(),
      paymentRequirements: terms(),
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, transaction: "0xabc" });
  });

  it("is off unless operators are configured", async () => {
    const { status, json } = await call(undefined, "/settle", {
      paymentPayload: payment(),
      paymentRequirements: terms(),
    });
    expect(status).toBe(400);
    expect(String(json["error"])).toMatch(/not enabled/);
  });

  it("rejects a malformed payload before settling anything", async () => {
    const bad = payment();
    const { status } = await call(enabled(), "/settle", {
      paymentPayload: { ...bad, payload: { ...bad.payload, signature: "0xabcd" } },
      paymentRequirements: terms(),
    });
    expect(status).toBe(400);
  });

  it("advertises the operators it relays for, and only when enabled", async () => {
    const on = await call(enabled(), "/supported");
    expect(JSON.stringify(on.json)).toContain(VAULT);
    const off = await call(undefined, "/supported");
    expect(JSON.stringify(off.json)).not.toContain("auth-capture");
  });
});
