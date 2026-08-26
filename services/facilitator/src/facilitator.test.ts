/**
 * Facilitator verification tests, driven against a stubbed Base Sepolia.
 *
 * The transport is faked; the cryptography is not. Signatures are produced by a
 * real key through viem's EIP-712 path and recovered by the facilitator's real
 * recovery path, so "altering terms invalidates the signature" is demonstrated
 * rather than asserted.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeFunctionResult,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  NETWORK_BASE_SEPOLIA,
  SCHEME_EXACT,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_BASE_SEPOLIA,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  X402_VERSION,
  usdcAbi,
  type PaymentPayload,
  type PaymentRequirements,
} from "@ntux402/shared";

import { Facilitator } from "./facilitator.js";

const CHAIN_ID = 84532;
const NOW = 1_800_000_000;
const VENDOR: Address = "0x1111111111111111111111111111111111111111";
const OTHER_VENDOR: Address = "0x2222222222222222222222222222222222222222";
const PRICE = "10000"; // 0.01 USDC

const payerKey = generatePrivateKey();
const payer = privateKeyToAccount(payerKey);
const settlerKey = generatePrivateKey();

/**
 * Enough of an RPC to answer the reads `verify` makes. viem talks JSON-RPC, so
 * intercepting at the transport keeps the facilitator's own client code — and
 * therefore its ABI encoding — under test.
 */
class FakeChain {
  balances = new Map<string, bigint>();
  usedNonces = new Set<string>();
  submitted: Array<{ data: Hex }> = [];
  revertSettlement = false;

  rpcUrl = "http://127.0.0.1:1/fake";

  handle = async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === "eth_chainId") return `0x${CHAIN_ID.toString(16)}`;
    if (method === "eth_call") {
      const { to, data } = params[0] as { to: Address; data: Hex };
      return this.#call(to, data);
    }
    throw new Error(`FakeChain: unhandled ${method}`);
  };

  #call(_to: Address, data: Hex): Hex {
    const selector = data.slice(0, 10);
    // balanceOf(address)
    if (selector === "0x70a08231") {
      const account = `0x${data.slice(34, 74)}`.toLowerCase();
      return encodeFunctionResult({
        abi: usdcAbi,
        functionName: "balanceOf",
        result: this.balances.get(account) ?? 0n,
      });
    }
    // authorizationState(address,bytes32)
    if (selector === "0xe94a0102") {
      const account = `0x${data.slice(34, 74)}`.toLowerCase();
      const nonce = `0x${data.slice(74, 138)}`.toLowerCase();
      return encodeFunctionResult({
        abi: usdcAbi,
        functionName: "authorizationState",
        result: this.usedNonces.has(`${account}:${nonce}`),
      });
    }
    throw new Error(`FakeChain: unhandled call selector ${selector}`);
  }
}

let chain: FakeChain;
let facilitator: Facilitator;

/** Patches global fetch so viem's http transport reaches the fake chain. */
beforeEach(() => {
  chain = new FakeChain();
  chain.balances.set(payer.address.toLowerCase(), 1_000_000n);

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const result = await chain.handle(body.method, body.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  facilitator = new Facilitator({
    rpcUrl: chain.rpcUrl,
    chainId: CHAIN_ID,
    asset: USDC_BASE_SEPOLIA,
    network: NETWORK_BASE_SEPOLIA,
    settlerKey,
    now: () => NOW,
  });
});

const requirements: PaymentRequirements = {
  scheme: SCHEME_EXACT,
  network: NETWORK_BASE_SEPOLIA,
  asset: USDC_BASE_SEPOLIA,
  payTo: VENDOR,
  maxAmountRequired: PRICE,
  resource: "https://mock-api.local/resource/honest",
};

const nonceFor = (goalId: bigint, seq: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [goalId, seq]));

async function signPayment(
  overrides: Partial<{
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
    from: Address;
  }> = {},
): Promise<PaymentPayload> {
  const authorization = {
    from: overrides.from ?? payer.address,
    to: overrides.to ?? VENDOR,
    value: overrides.value ?? PRICE,
    validAfter: overrides.validAfter ?? String(NOW - 1),
    validBefore: overrides.validBefore ?? String(NOW + 3600),
    nonce: overrides.nonce ?? nonceFor(1n, 1n),
  };

  const signature = await payer.signTypedData({
    domain: {
      name: USDC_EIP712_NAME,
      version: USDC_EIP712_VERSION,
      chainId: CHAIN_ID,
      verifyingContract: USDC_BASE_SEPOLIA,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });

  return {
    x402Version: X402_VERSION,
    scheme: SCHEME_EXACT,
    network: NETWORK_BASE_SEPOLIA,
    payload: { signature, authorization },
  };
}

describe("Facilitator.verify", () => {
  it("accepts a correctly signed, correctly priced payment", async () => {
    const result = await facilitator.verify(await signPayment(), requirements);
    expect(result).toEqual({ isValid: true, payer: payer.address });
  });

  it("accepts an overpayment — paying more is the payer's own loss", async () => {
    const result = await facilitator.verify(await signPayment({ value: "20000" }), requirements);
    expect(result.isValid).toBe(true);
  });

  it("rejects an underpayment", async () => {
    const result = await facilitator.verify(await signPayment({ value: "9999" }), requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("insufficient");
  });

  it("rejects a payment to the wrong payee", async () => {
    const result = await facilitator.verify(await signPayment({ to: OTHER_VENDOR }), requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("payee mismatch");
  });

  // The property ARCHITECTURE.md rests on: the facilitator is trusted to relay, not to
  // preserve terms — the signature is what preserves them.
  it("rejects terms tampered with after signing", async () => {
    const payment = await signPayment();
    const tampered: PaymentPayload = {
      ...payment,
      payload: {
        ...payment.payload,
        authorization: { ...payment.payload.authorization, to: OTHER_VENDOR },
      },
    };
    const result = await facilitator.verify(tampered, {
      ...requirements,
      payTo: OTHER_VENDOR,
    });
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("signature recovers to");
  });

  it("rejects an authorization that is not yet valid", async () => {
    const result = await facilitator.verify(
      await signPayment({ validAfter: String(NOW + 60) }),
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("not yet valid");
  });

  it("rejects an expired authorization", async () => {
    const result = await facilitator.verify(
      await signPayment({ validBefore: String(NOW - 1) }),
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("expired");
  });

  it("rejects an authorization the token has already consumed", async () => {
    const payment = await signPayment();
    chain.usedNonces.add(
      `${payer.address.toLowerCase()}:${payment.payload.authorization.nonce.toLowerCase()}`,
    );
    const result = await facilitator.verify(payment, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("already been used");
  });

  // The second, independent spending bound from ARCHITECTURE.md.
  it("rejects when the ephemeral payer is underfunded", async () => {
    chain.balances.set(payer.address.toLowerCase(), 5_000n);
    const result = await facilitator.verify(await signPayment(), requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("underfunded");
  });

  it("rejects an asset it does not settle", async () => {
    const result = await facilitator.verify(await signPayment(), {
      ...requirements,
      asset: "0x00000000000000000000000000000000DeaDBeef",
    });
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("not settled by this facilitator");
  });

  it("rejects a payment for another network", async () => {
    const payment = await signPayment();
    const result = await facilitator.verify(
      { ...payment, network: "base" },
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("network mismatch");
  });
});

describe("Facilitator.settle", () => {
  // The settlement-side half of the no-double-pay property. The signer supplies
  // a byte-identical tuple on retry (tested in @ntux402/signer); here, the
  // facilitator notices the token already consumed it and does not submit again.
  it("reports success without resubmitting an already-consumed authorization", async () => {
    const payment = await signPayment();
    chain.usedNonces.add(
      `${payer.address.toLowerCase()}:${payment.payload.authorization.nonce.toLowerCase()}`,
    );

    const result = await facilitator.settle(payment, requirements);
    expect(result.success).toBe(true);
    expect(result.alreadySettled).toBe(true);
    expect(result.transaction).toBeUndefined();
    expect(chain.submitted).toHaveLength(0);
  });

  it("refuses to settle a payment that does not verify", async () => {
    const result = await facilitator.settle(
      await signPayment({ value: "1" }),
      requirements,
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toContain("insufficient");
    expect(chain.submitted).toHaveLength(0);
  });
});
