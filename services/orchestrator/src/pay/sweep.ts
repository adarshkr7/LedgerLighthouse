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
 *
 * ## On an escrow vault
 *
 * The signer's response carries the `payment` it signed, and the sweep goes through the
 * vault's `charge`, sent by the relay. The facilitator has no part in it. The vault
 * re-checks that the goal is closed and that the receiver is its owner, so this process
 * still has no say in where the money goes.
 */

import {
  SCHEME_EXACT,
  networkForChainId,
  X402_VERSION,
  type Address,
  type SettleResponse,
} from "@ntux402/shared";

import type {
  EscrowPaymentTerms,
  SignedAuthorization,
  SignerClient,
  SweepAuthorizationOutcome,
} from "./signer-client.js";

export type SweepOutcome =
  | { readonly kind: "settled"; readonly settlement: SettleResponse; readonly amount: string; readonly to: Address }
  | { readonly kind: "refused"; readonly status: number; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface SweepConfig {
  /** The signer, already carrying its bearer token. Never a bare URL — see the header. */
  readonly signer: SignerClient;
  readonly facilitatorUrl: string | undefined;
  /** Submits a sweep the signer signed through the escrow. See the header. */
  readonly relay?: {
    sweep(payment: EscrowPaymentTerms, signature: `0x${string}`): Promise<{ readonly txHash: `0x${string}` }>;
  };
  readonly usdcAddress: Address;
  /** For the facilitator leg only; the signer leg goes through `signer`. */
  readonly fetchImpl?: typeof fetch;
  /** How long to wait out a stale "still open". See `askSignerToSweep`. */
  readonly retry?: { readonly attempts?: number; readonly intervalMs?: number };
}

/**
 * Asks the signer for a sweep of a goal the caller has just closed.
 *
 * Callers sweep right after `closeGoal` confirms: the console does, and so does
 * `tools/e2e` sweep. The signer reads the goal through its own RPC, and on a
 * load-balanced endpoint that read can come from a node behind the receipt,
 * so the first answer is a refusal saying the goal is "still open". The first
 * live run of the sweep script hit exactly that on 9 October 2026.
 *
 * That one refusal is retried for a bounded time. Every other answer is final,
 * and a goal that really is open is still refused, only later.
 */
export async function askSignerToSweep(
  signer: SignerClient,
  goalId: string,
  options: { readonly attempts?: number; readonly intervalMs?: number } = {},
): Promise<SweepAuthorizationOutcome> {
  const attempts = options.attempts ?? 8;
  const intervalMs = options.intervalMs ?? 2_500;
  for (let attempt = 1; ; attempt++) {
    const outcome = await signer.sweep(goalId);
    const staleOpen =
      outcome.kind === "refused" && outcome.status === 409 && outcome.reason.includes("still open");
    if (!staleOpen || attempt >= attempts) return outcome;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function sweepGoal(goalId: string, config: SweepConfig): Promise<SweepOutcome> {
  const doFetch = config.fetchImpl ?? globalThis.fetch;

  const stubbed: SweepOutcome = {
    kind: "refused",
    status: 409,
    reason:
      "settlement is stubbed — there is no facilitator configured, so a sweep would sign an " +
      "authorization nobody submits. Set X402_FACILITATOR_URL.",
  };
  if (config.facilitatorUrl === undefined && config.relay === undefined) return stubbed;

  // --- ask the signer ------------------------------------------------------
  const authorized = await askSignerToSweep(config.signer, goalId, config.retry);
  if (authorized.kind === "unreachable") {
    return { kind: "failed", reason: `signer unreachable: ${authorized.reason}` };
  }
  if (authorized.kind === "refused") {
    // The signer's refusals are the informative ones — goal still open, no
    // balance, wrong token — so they are passed through rather than flattened.
    return { kind: "refused", status: authorized.status, reason: authorized.reason };
  }
  const signed: SignedAuthorization = authorized.value;

  // The network is the one the signer signed for, so the envelope cannot name
  // a different chain from the signature inside it.
  const network = networkForChainId(signed.chainId);
  if (network === undefined) {
    return { kind: "failed", reason: `signer signed for chain ${signed.chainId}, which is not a known network` };
  }

  // --- through the escrow --------------------------------------------------
  if (signed.payment !== undefined) {
    if (config.relay === undefined) {
      return { kind: "failed", reason: "the signer settles through the escrow, and no relay was given to submit it" };
    }
    try {
      const { txHash } = await config.relay.sweep(signed.payment, signed.signature);
      return {
        kind: "settled",
        settlement: { success: true, transaction: txHash, network: network.x402Network, payer: signed.payment.payer },
        amount: signed.payment.maxAmount,
        to: signed.payment.receiver,
      };
    } catch (e) {
      return { kind: "failed", reason: `the vault refused the sweep: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
    }
  }
  if (config.facilitatorUrl === undefined) return stubbed;

  // --- submit it -----------------------------------------------------------
  const envelope = {
    paymentPayload: {
      x402Version: X402_VERSION,
      scheme: SCHEME_EXACT,
      network: network.x402Network,
      payload: { signature: signed.signature, authorization: signed.authorization },
    },
    paymentRequirements: {
      scheme: SCHEME_EXACT,
      network: network.x402Network,
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
