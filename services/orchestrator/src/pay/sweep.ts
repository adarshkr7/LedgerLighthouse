/**
 * Returning an ephemeral payer's leftover USDC to the goal owner.
 *
 * The UI has always told people they can do this. Until now nothing could:
 * there was no sweep path in the contract, the signer, or here — the sentence
 * was simply untrue. This is the half that moves the money; the half that
 * decides *where* it goes is `AuthorizationSigner.sweep`, and it deliberately
 * lives there rather than here.
 *
 * ## Why the orchestrator does not get a say
 *
 * This module forwards. It sends `{ goalId }` to the signer and forwards
 * whatever authorization comes back to the facilitator. It does not choose the
 * amount, the destination or the token, and it could not: the signer reads all
 * three from the chain and the caller has no field to express them in. The
 * orchestrator stays exactly as untrusted for a sweep as it is for a spend.
 *
 * ## The payment requirements are derived, not asserted
 *
 * The facilitator cross-checks the authorization against the requirements it is
 * given, and for a sweep those requirements are built from the authorization
 * itself — so that particular check is a tautology here. It is not what makes
 * the sweep safe. The signature is: it covers `from`, `to`, `value` and the
 * nonce, it was produced inside the signer from chain state, and the token
 * verifies it independently at `transferWithAuthorization`. Nothing this
 * process constructs can widen it.
 */

import {
  NETWORK_BASE_SEPOLIA,
  SCHEME_EXACT,
  X402_VERSION,
  type Address,
  type SettleResponse,
} from "@ntux402/shared";

export type SweepOutcome =
  | { readonly kind: "settled"; readonly settlement: SettleResponse; readonly amount: string; readonly to: Address }
  | { readonly kind: "refused"; readonly status: number; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface SweepConfig {
  readonly signerUrl: string;
  readonly facilitatorUrl: string | undefined;
  readonly usdcAddress: Address;
  readonly fetchImpl?: typeof fetch;
}

interface SignedSweep {
  readonly authorization: {
    readonly from: Address;
    readonly to: Address;
    readonly value: string;
    readonly validAfter: string;
    readonly validBefore: string;
    readonly nonce: `0x${string}`;
  };
  readonly signature: `0x${string}`;
}

export async function sweepGoal(goalId: string, config: SweepConfig): Promise<SweepOutcome> {
  const doFetch = config.fetchImpl ?? globalThis.fetch;

  if (config.facilitatorUrl === undefined) {
    return {
      kind: "refused",
      status: 409,
      reason:
        "settlement is stubbed — there is no facilitator configured, so a sweep would sign an " +
        "authorization nobody submits. Set X402_FACILITATOR_URL.",
    };
  }

  // --- ask the signer ------------------------------------------------------
  let signed: SignedSweep;
  try {
    const response = await doFetch(`${config.signerUrl}/sweeps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const reason =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: unknown }).error)
          : `signer returned ${response.status}`;
      // The signer's refusals are the informative ones — goal still open, no
      // balance, wrong token — so they are passed through rather than flattened.
      return { kind: "refused", status: response.status, reason };
    }
    signed = body as SignedSweep;
  } catch (e) {
    return { kind: "failed", reason: `signer unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }

  // --- submit it -----------------------------------------------------------
  const envelope = {
    paymentPayload: {
      x402Version: X402_VERSION,
      scheme: SCHEME_EXACT,
      network: NETWORK_BASE_SEPOLIA,
      payload: { signature: signed.signature, authorization: signed.authorization },
    },
    paymentRequirements: {
      scheme: SCHEME_EXACT,
      network: NETWORK_BASE_SEPOLIA,
      maxAmountRequired: signed.authorization.value,
      resource: `goal:${goalId}/sweep`,
      description: "Return of unspent ephemeral payer balance to the goal owner",
      mimeType: "application/json",
      payTo: signed.authorization.to,
      maxTimeoutSeconds: 60,
      asset: config.usdcAddress,
    },
  };

  try {
    const response = await doFetch(`${config.facilitatorUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const settlement = (await response.json()) as SettleResponse;
    if (!settlement.success) {
      return {
        kind: "failed",
        reason: settlement.errorReason ?? `facilitator returned ${response.status}`,
      };
    }
    return {
      kind: "settled",
      settlement,
      amount: signed.authorization.value,
      to: signed.authorization.to,
    };
  } catch (e) {
    return {
      kind: "failed",
      reason: `facilitator unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
