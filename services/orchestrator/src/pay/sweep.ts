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
 * ## It takes a `SignerClient`, not a URL
 *
 * This used to reach the signer with its own `fetch` and a bare `signerUrl`,
 * which meant it sent no `Authorization` header. Against a loopback signer that
 * is invisible; against the ROFL-hosted one, where `SERVICE_TOKEN` is
 * mandatory, every sweep was a 401 — and the console had already closed the
 * goal on chain by the time it found out. `SignerClient` is the one place the
 * token is read, so taking the client rather than an address is what keeps
 * this leg authenticated by construction.
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

import type { SignedAuthorization, SignerClient } from "./signer-client.js";

export type SweepOutcome =
  | { readonly kind: "settled"; readonly settlement: SettleResponse; readonly amount: string; readonly to: Address }
  | { readonly kind: "refused"; readonly status: number; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface SweepConfig {
  /** The signer, already carrying its bearer token. Never a bare URL — see the header. */
  readonly signer: SignerClient;
  readonly facilitatorUrl: string | undefined;
  readonly usdcAddress: Address;
  /** For the facilitator leg only; the signer leg goes through `signer`. */
  readonly fetchImpl?: typeof fetch;
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
  const authorized = await config.signer.sweep(goalId);
  if (authorized.kind === "unreachable") {
    return { kind: "failed", reason: `signer unreachable: ${authorized.reason}` };
  }
  if (authorized.kind === "refused") {
    // The signer's refusals are the informative ones — goal still open, no
    // balance, wrong token — so they are passed through rather than flattened.
    return { kind: "refused", status: authorized.status, reason: authorized.reason };
  }
  const signed: SignedAuthorization = authorized.value;

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
