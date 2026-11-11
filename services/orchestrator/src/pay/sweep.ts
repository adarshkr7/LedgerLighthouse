/**
 * Returning an ephemeral payer's leftover USDC to the goal owner.
 *
 * This is the half that moves the money. The half that decides *where* it goes is
 * the signer's `sweep`, and it deliberately lives there and not here.
 *
 * ## Why the orchestrator does not get a say
 *
 * This module forwards. It sends `{ goalId }` to the signer and submits whatever
 * payment comes back through the vault's `charge`. It does not choose the amount, the
 * destination or the token, and it could not: the signer reads all three from the
 * chain and the caller has no field to express them in. The vault then re-checks that
 * the goal is closed and that the receiver is its owner, so a relay that altered the
 * payment gets a revert. The orchestrator stays exactly as untrusted for a sweep as it
 * is for a spend.
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
 */

import { networkForChainId, type Address, type SettleResponse } from "@ntux402/shared";

import type { EscrowPaymentTerms, SignerClient, SweepAuthorizationOutcome } from "./signer-client.js";

export type SweepOutcome =
  | { readonly kind: "settled"; readonly settlement: SettleResponse; readonly amount: string; readonly to: Address }
  | { readonly kind: "refused"; readonly status: number; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface SweepConfig {
  /** The signer, already carrying its bearer token. Never a bare URL — see the header. */
  readonly signer: SignerClient;
  /** Submits the signed payment to the vault. Anyone may, and it can only pay the owner. */
  readonly relay: {
    sweep(payment: EscrowPaymentTerms, signature: `0x${string}`): Promise<{ readonly txHash: `0x${string}` }>;
  };
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
  const authorized = await askSignerToSweep(config.signer, goalId, config.retry);
  if (authorized.kind === "unreachable") {
    return { kind: "failed", reason: `signer unreachable: ${authorized.reason}` };
  }
  if (authorized.kind === "refused") {
    // The signer's refusals are the informative ones — goal still open, no
    // balance, wrong token — so they are passed through rather than flattened.
    return { kind: "refused", status: authorized.status, reason: authorized.reason };
  }
  const { payment, signature, chainId } = authorized.value;

  // The network is the one the signer signed for, so what is reported cannot name a
  // different chain from the signature it describes.
  const network = networkForChainId(chainId);
  if (network === undefined) {
    return { kind: "failed", reason: `signer signed for chain ${chainId}, which is not a known network` };
  }
  if (payment === undefined) {
    return { kind: "failed", reason: "the signer returned no escrow payment, so there is nothing the vault would take" };
  }

  try {
    const { txHash } = await config.relay.sweep(payment, signature);
    return {
      kind: "settled",
      settlement: { success: true, transaction: txHash, network: network.x402Network, payer: payment.payer },
      amount: payment.maxAmount,
      to: payment.receiver,
    };
  } catch (e) {
    return {
      kind: "failed",
      reason: `the vault refused the sweep: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
    };
  }
}
