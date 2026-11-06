/**
 * The payment loop on an escrow vault. The chain, Inco and the signer are faked, as in
 * payment-loop.test.ts, and the vendor is too: these tests are about what the loop does
 * and refuses. The whole flow against real contracts is in tools/e2e/src/escrow-flow.ts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  AUTH_CAPTURE_ESCROW,
  ERC3009_TOKEN_COLLECTOR,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE_V2,
  SCHEME_EXACT,
  USDC_BASE_SEPOLIA,
  X402_VERSION,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodeSettlementHeader,
  paymentSalt,
  splitPaymentSalt,
  type AuthCaptureRequirements,
  type AuthCapturePayload,
  NETWORK_BASE_SEPOLIA,
} from "@ntux402/shared";

import { ScriptedAgent } from "../agent/scripted.js";
import type { AttestedDecision, DecisionReader } from "../inco/reveal.js";
import { X402Client } from "../x402/client.js";
import { PaymentLoop, type PaymentEvent } from "./payment-loop.js";
import type { ReclaimOutcome, SpendRequested, VaultRelay } from "./relay.js";
import { SignerClient, type EscrowPaymentTerms } from "./signer-client.js";

const NETWORK = "eip155:84532";
const VAULT: Address = "0x00000000000000000000000000000000000ab0b1";
const OTHER_VAULT: Address = "0x00000000000000000000000000000000000ab0b2";
const VENDOR: Address = "0x0000000000000000000000000000000000007e57";
const PAYER: Address = "0x5555555555555555555555555555555555555555";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const HANDLE = `0x${"ab".repeat(32)}` as Hex;
const TERMS_HASH = `0x${"cd".repeat(32)}` as Hex;
const URL_ = "https://vendor.example/resource/honest";
const NOW_SECONDS = 1_800_000_000;
const CAPTURE_DEADLINE = NOW_SECONDS + 360;

const offer = (over: { operator?: Address; deadline?: number } = {}): AuthCaptureRequirements => ({
  scheme: "auth-capture",
  network: NETWORK,
  amount: "10000",
  asset: USDC_BASE_SEPOLIA,
  payTo: VENDOR,
  maxTimeoutSeconds: 60,
  extra: {
    name: "USDC",
    version: "2",
    authCaptureEscrow: AUTH_CAPTURE_ESCROW,
    captureAuthorizer: over.operator ?? VAULT,
    operatorType: "custom",
    paymentFlow: "escrow",
    captureDeadline: over.deadline ?? CAPTURE_DEADLINE,
    refundDeadline: over.deadline ?? CAPTURE_DEADLINE,
    minFeeBps: 0,
    maxFeeBps: 0,
    feeRecipient: ZERO,
    assetTransferMethod: "eip3009",
  },
});

class FakeVendor {
  offers: AuthCaptureRequirements[] = [offer()];
  received: AuthCapturePayload[] = [];
  refuseWith: string | undefined;
  /** Answer with a v1 402 instead. */
  v1 = false;
  /** Answer with a header that does not decode. */
  garbled = false;

  #paymentRequired(error?: string): Response {
    if (this.garbled) return new Response("{}", { status: 402, headers: { [HEADER_PAYMENT_REQUIRED]: "not json" } });
    return new Response("{}", {
      status: 402,
      headers: {
        [HEADER_PAYMENT_REQUIRED]: encodePaymentRequiredHeader({
          x402Version: 2,
          ...(error ? { error } : {}),
          resource: { url: URL_, description: "Ordinary market data feed." },
          accepts: this.offers,
        }),
      },
    });
  }

  fetch: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    const payment = headers.get("PAYMENT-SIGNATURE");
    if (!payment) {
      if (!this.v1) return this.#paymentRequired();
      return new Response(
        JSON.stringify({
          x402Version: X402_VERSION,
          accepts: [
            {
              scheme: SCHEME_EXACT,
              network: NETWORK_BASE_SEPOLIA,
              maxAmountRequired: "10000",
              asset: USDC_BASE_SEPOLIA,
              payTo: VENDOR,
              resource: URL_,
              description: "Ordinary market data feed.",
              maxTimeoutSeconds: 60,
            },
          ],
        }),
        { status: 402 },
      );
    }
    const decoded = decodePaymentSignatureHeader(payment);
    if (!decoded.ok) throw new Error(decoded.error);
    this.received.push(decoded.value);
    if (this.refuseWith !== undefined) return this.#paymentRequired(this.refuseWith);
    return new Response(JSON.stringify({ data: { premium: true } }), {
      status: 200,
      headers: {
        [HEADER_PAYMENT_RESPONSE_V2]: encodeSettlementHeader({
          success: true,
          transaction: `0x${"99".repeat(32)}`,
          claimTransaction: `0x${"88".repeat(32)}`,
          network: NETWORK,
        }),
      },
    });
  };
}

class FakeRelay {
  escrowSpends: { deadline: number; keyHash: Hex; payTo: Address }[] = [];
  plainSpends = 0;
  reclaims = 0;
  reclaimResult: ReclaimOutcome = { kind: "reclaimed", txHash: `0x${"55".repeat(32)}`, gasUsed: 1n };

  async pendingSeq() {
    return 0n;
  }
  hasFinalized() {
    return false;
  }
  async waitUntilVisible() {}
  async requestSpend(): Promise<SpendRequested> {
    this.plainSpends++;
    throw new Error("a direct request on an escrow vault");
  }
  async requestEscrowSpend(
    _goalId: bigint,
    _amount: bigint,
    payTo: Address,
    _resource: string,
    payBy: bigint,
    deadline: number,
    keyHash: Hex,
  ): Promise<SpendRequested> {
    this.escrowSpends.push({ deadline, keyHash, payTo });
    return {
      seq: 1n,
      decisionHandle: HANDLE,
      termsHash: TERMS_HASH,
      validAfter: 0n,
      validBefore: payBy,
      commitTx: `0x${"11".repeat(32)}`,
      gasUsed: 1n,
    };
  }
  async finalizeDecision() {
    return { txHash: `0x${"22".repeat(32)}` as Hex, gasUsed: 1n };
  }
  async reclaimExpired(): Promise<ReclaimOutcome> {
    this.reclaims++;
    return this.reclaimResult;
  }
}

class FakeDecisions implements DecisionReader {
  decision: AttestedDecision = { approved: true, signatures: [`0x${"33".repeat(65)}`] };
  async read() {
    return this.decision;
  }
}

function signerResponse(terms: Partial<EscrowPaymentTerms> | undefined): Response {
  const payment: EscrowPaymentTerms | undefined =
    terms === undefined
      ? undefined
      : {
          operator: VAULT,
          payer: PAYER,
          receiver: VENDOR,
          token: USDC_BASE_SEPOLIA,
          maxAmount: "10000",
          preApprovalExpiry: NOW_SECONDS + 60,
          authorizationExpiry: CAPTURE_DEADLINE,
          refundExpiry: CAPTURE_DEADLINE,
          salt: paymentSalt(1n, 1n).toString(),
          ...terms,
        };
  return new Response(
    JSON.stringify({
      goalId: "1",
      seq: "1",
      token: USDC_BASE_SEPOLIA,
      chainId: 84532,
      authorization: {
        from: PAYER,
        to: ERC3009_TOKEN_COLLECTOR,
        value: "10000",
        validAfter: "0",
        validBefore: String(NOW_SECONDS + 60),
        nonce: `0x${"ef".repeat(32)}`,
      },
      signature: `0x${"44".repeat(65)}`,
      termsHash: TERMS_HASH,
      ...(payment ? { payment } : {}),
    }),
    { status: 200 },
  );
}

describe("PaymentLoop on an escrow vault", () => {
  let vendor: FakeVendor;
  let relay: FakeRelay;
  let events: PaymentEvent[];
  let signed: Partial<EscrowPaymentTerms> | undefined;

  const build = (escrow = true) =>
    new PaymentLoop({
      client: new X402Client({ fetchImpl: vendor.fetch, sleep: async () => {} }),
      relay: relay as unknown as VaultRelay,
      decisions: new FakeDecisions(),
      signer: new SignerClient("http://signer", (async () => signerResponse(signed)) as typeof fetch),
      agent: new ScriptedAgent(),
      asset: USDC_BASE_SEPOLIA,
      network: NETWORK_BASE_SEPOLIA,
      ...(escrow ? { escrow: { vault: VAULT, network: NETWORK } } : {}),
      now: () => NOW_SECONDS * 1000,
      sleep: async () => {},
      poll: { sleep: async () => {} },
      onEvent: (e) => events.push(e),
    });

  beforeEach(() => {
    vendor = new FakeVendor();
    relay = new FakeRelay();
    events = [];
    signed = {};
  });

  it("buys through the escrow: the offer's deadline to the vault, the signature to the vendor", async () => {
    const result = await build().fetchPaid(URL_, 1n);

    expect(result.kind).toBe("paid");
    expect(relay.escrowSpends).toEqual([{ deadline: CAPTURE_DEADLINE, keyHash: `0x${"00".repeat(32)}`, payTo: VENDOR }]);
    expect(relay.plainSpends).toBe(0);

    const payment = vendor.received[0]!;
    expect(payment.accepted).toEqual(offer());
    expect(payment.payload.authorization.to).toBe(ERC3009_TOKEN_COLLECTOR);
    expect(splitPaymentSalt(payment.payload.salt)).toEqual({ goalId: 1n, seq: 1n });
    if (result.kind === "paid") expect(result.settlement?.claimTransaction).toBe(`0x${"88".repeat(32)}`);
  });

  /** The operator is the contract whose checks stand between a signature and the money. */
  it("refuses an offer naming another operator, before committing anything", async () => {
    vendor.offers = [offer({ operator: OTHER_VAULT })];
    const result = await build().fetchPaid(URL_, 1n);
    expect(result).toMatchObject({ kind: "failed" });
    expect(relay.escrowSpends).toHaveLength(0);
    expect(events.some((e) => e.type === "terms-rejected")).toBe(true);
  });

  it("refuses an offer on another network, before committing anything", async () => {
    vendor.offers = [{ ...offer(), network: "eip155:8453" }];
    expect(await build().fetchPaid(URL_, 1n)).toMatchObject({ kind: "failed" });
    expect(relay.escrowSpends).toHaveLength(0);
  });

  it("reports a garbled 402 as malformed, and commits nothing", async () => {
    vendor.garbled = true;
    const result = await build().fetchPaid(URL_, 1n);
    expect(result).toMatchObject({ kind: "failed" });
    if (result.kind === "failed") expect(result.reason).toMatch(/malformed 402/);
    expect(relay.escrowSpends).toHaveLength(0);
  });

  /** One offer outside the profile rejects the 402, so a vendor cannot slip one past. */
  it("refuses a 402 asking for a delegated operator, before committing anything", async () => {
    vendor.offers = [{ ...offer(), extra: { ...offer().extra, operatorType: "delegated" as never } }];
    const result = await build().fetchPaid(URL_, 1n);
    expect(result).toMatchObject({ kind: "failed" });
    if (result.kind === "failed") expect(result.reason).toMatch(/malformed 402/);
    expect(relay.escrowSpends).toHaveLength(0);
  });

  it("picks the offer naming this vault when a vendor lists several", async () => {
    vendor.offers = [offer({ operator: OTHER_VAULT }), offer()];
    expect((await build().fetchPaid(URL_, 1n)).kind).toBe("paid");
    expect(vendor.received[0]!.accepted.extra.captureAuthorizer).toBe(VAULT);
  });

  it("refuses a v1 offer on an escrow vault, so a vendor cannot choose the weaker flow", async () => {
    vendor.v1 = true;
    expect(await build().fetchPaid(URL_, 1n)).toMatchObject({ kind: "failed" });
    expect(relay.plainSpends).toBe(0);
    expect(relay.escrowSpends).toHaveLength(0);
  });

  it("refuses an escrow offer on a vault that cannot pay through one", async () => {
    expect(await build(false).fetchPaid(URL_, 1n)).toMatchObject({ kind: "failed" });
    expect(relay.escrowSpends).toHaveLength(0);
  });

  describe("does not present a signature that disagrees with the offer", () => {
    const cases: [string, Partial<EscrowPaymentTerms>][] = [
      ["another operator", { operator: OTHER_VAULT }],
      ["another receiver", { receiver: PAYER }],
      ["another token", { token: VENDOR }],
      ["another amount", { maxAmount: "1" }],
      ["another deadline", { authorizationExpiry: CAPTURE_DEADLINE + 1 }],
    ];
    it.each(cases)("%s", async (_name, terms) => {
      signed = terms;
      expect(await build().fetchPaid(URL_, 1n)).toMatchObject({ kind: "failed" });
      expect(vendor.received).toHaveLength(0);
      expect(relay.reclaims).toBe(1);
    });

    it("a signer not in escrow mode", async () => {
      signed = undefined;
      const result = await build().fetchPaid(URL_, 1n);
      expect(result).toMatchObject({ kind: "failed" });
      if (result.kind === "failed") expect(result.reason).toMatch(/SIGNER_SETTLEMENT/);
      expect(vendor.received).toHaveLength(0);
    });
  });

  it("reports a refused payment in the vendor's words, and reclaims", async () => {
    vendor.refuseWith = "the hold failed";
    const result = await build().fetchPaid(URL_, 1n);
    expect(result).toMatchObject({ kind: "failed" });
    if (result.kind === "failed") expect(result.reason).toContain('said: "the hold failed"');
    expect(relay.reclaims).toBe(1);
  });

  it("leaves a rejected request unpaid and unsigned", async () => {
    const loop = new PaymentLoop({
      client: new X402Client({ fetchImpl: vendor.fetch, sleep: async () => {} }),
      relay: relay as unknown as VaultRelay,
      decisions: { read: async () => ({ approved: false, signatures: [] }) },
      signer: new SignerClient("http://signer", (async () => {
        throw new Error("the signer must not be asked");
      }) as typeof fetch),
      agent: new ScriptedAgent(),
      asset: USDC_BASE_SEPOLIA,
      escrow: { vault: VAULT, network: NETWORK },
      now: () => NOW_SECONDS * 1000,
      poll: { sleep: async () => {} },
    });
    expect((await loop.fetchPaid(URL_, 1n)).kind).toBe("policy-rejected");
    expect(vendor.received).toHaveLength(0);
  });
});
