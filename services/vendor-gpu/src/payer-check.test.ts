import { describe, expect, it } from "vitest";

import { privateKeyToAccount } from "viem/accounts";
import {
  NETWORK_BASE_SEPOLIA,
  SCHEME_EXACT,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  X402_VERSION,
  type Address,
  type PaymentPayload,
} from "@ntux402/shared";

import { Eip3009PayerCheck } from "./payer-check.js";

const CHAIN_ID = 84532;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const PAYEE = "0x4444444444444444444444444444444444444444" as Address;

// A throwaway key. It signs test vectors and holds nothing.
const payer = privateKeyToAccount(`0x${"7b".repeat(32)}`);
const impostor = privateKeyToAccount(`0x${"1d".repeat(32)}`);

const authorization = {
  from: payer.address,
  to: PAYEE,
  value: 120_000n,
  validAfter: 0n,
  validBefore: 9_999_999_999n,
  nonce: `0x${"22".repeat(32)}` as `0x${string}`,
};

async function payloadSignedBy(
  account: typeof payer,
  overrides: Partial<typeof authorization> = {},
): Promise<PaymentPayload> {
  const message = { ...authorization, ...overrides };
  const signature = await account.signTypedData({
    domain: {
      name: USDC_EIP712_NAME,
      version: USDC_EIP712_VERSION,
      chainId: CHAIN_ID,
      verifyingContract: ASSET,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  return {
    x402Version: X402_VERSION,
    scheme: SCHEME_EXACT,
    network: NETWORK_BASE_SEPOLIA,
    payload: {
      signature,
      authorization: {
        from: message.from,
        to: message.to,
        value: message.value.toString(),
        validAfter: message.validAfter.toString(),
        validBefore: message.validBefore.toString(),
        nonce: message.nonce,
      },
    },
  };
}

/**
 * Rebuilds a payload with something changed after it was signed.
 *
 * `PaymentPayload` is readonly throughout, which is the right shape for a thing
 * that carries a signature — so a test that tampers with one has to construct
 * the tampered version rather than reach in and edit it.
 */
function tampered(
  payload: PaymentPayload,
  changes: { signature?: string; authorization?: Record<string, string> },
): PaymentPayload {
  return {
    ...payload,
    payload: {
      // Cast so a test can supply something that is not a signature at all,
      // which is one of the cases this check exists to refuse.
      signature: (changes.signature ??
        payload.payload.signature) as PaymentPayload["payload"]["signature"],
      authorization: {
        ...payload.payload.authorization,
        ...(changes.authorization ?? {}),
      } as PaymentPayload["payload"]["authorization"],
    },
  };
}

const check = new Eip3009PayerCheck({ chainId: CHAIN_ID });

describe("Eip3009PayerCheck", () => {
  it("accepts a payload the named payer really signed", async () => {
    expect(await check.signedByPayer(await payloadSignedBy(payer), ASSET)).toBe(true);
  });

  /*
   * The whole reason this exists. The spend nonce is public, so a caller who
   * read one out of a trace must not be able to claim the lease it paid for.
   */
  it("refuses a payload signed by somebody else", async () => {
    // The impostor signed it, but the payload claims the real payer.
    const forged = tampered(await payloadSignedBy(impostor), {
      authorization: { from: payer.address },
    });
    expect(await check.signedByPayer(forged, ASSET)).toBe(false);
  });

  it("refuses a payload with no real signature at all", async () => {
    const payload = tampered(await payloadSignedBy(payer), {
      signature: `0x${"11".repeat(65)}`,
    });
    expect(await check.signedByPayer(payload, ASSET)).toBe(false);
  });

  it("refuses a malformed signature instead of throwing", async () => {
    const payload = tampered(await payloadSignedBy(payer), { signature: "not-a-signature" });
    expect(await check.signedByPayer(payload, ASSET)).toBe(false);
  });

  /*
   * The authorization is what was signed, so editing any of it after the fact
   * has to break the check — otherwise a replay could quietly change the payee
   * or the amount and still be handed the lease.
   */
  it("refuses a payload whose fields were edited after signing", async () => {
    const signed = await payloadSignedBy(payer);

    const cheapened = tampered(signed, { authorization: { value: "1" } });
    expect(await check.signedByPayer(cheapened, ASSET)).toBe(false);

    const repointed = tampered(signed, { authorization: { to: impostor.address } });
    expect(await check.signedByPayer(repointed, ASSET)).toBe(false);
  });

  /*
   * A signature is only meaningful against the domain it was made for. The same
   * bytes on a different chain, or for a different token, are a different
   * authorization and must not verify here.
   */
  it("refuses a signature made for another domain", async () => {
    const payload = await payloadSignedBy(payer);
    expect(await new Eip3009PayerCheck({ chainId: 1 }).signedByPayer(payload, ASSET)).toBe(false);
    expect(await check.signedByPayer(payload, PAYEE)).toBe(false);
  });
});
