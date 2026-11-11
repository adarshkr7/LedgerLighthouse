/**
 * The payment loop. Plan §7, end to end:
 *
 *   402 -> requestSpend -> poll attestedReveal -> finalizeDecision
 *       -> signer(goalId, seq) -> X-PAYMENT -> retry -> data
 *
 * ## What this component is and is not trusted for
 *
 * It decides *what* to request and sequences the calls. It does not evaluate
 * policy, hold a payer key, or learn the budget. Read the code for what is
 * missing: there is no branch that compares an amount against a limit, because
 * the only component that may do that is the vault, and it does it encrypted.
 *
 * ## Two shapes that look like bugs and are not
 *
 * **A rejection is terminal.** No retry, no smaller amount. Catching a policy
 * rejection and retrying is the anti-pattern in ARCHITECTURE.md — the bounce is the
 * product, so it is returned as a first-class outcome and surfaced.
 *
 * **A reveal timeout is not a rejection.** The debit committed at
 * `requestSpend`. If the compute server stalls, the budget has moved and the
 * decision is unobtainable — a distinct, reportable state (ARCHITECTURE.md). Merging
 * it into "rejected" would be a lie about where the money went.
 *
 * ## The vendor's hold
 *
 * A vendor holds what it quoted for `maxTimeoutSeconds`, from the moment it
 * answered 402, like a seat held while you pay. The authorization ends there
 * too (`payBy`), so a payment slowed past the hold cannot be collected for a
 * thing the vendor has already let go. A run with too little of the hold left
 * stops before it commits anything. And an approved amount that was not paid
 * goes back to the budget once its authorization has expired (`#reclaim`).
 */

import {
  saltToHex,
  selectEscrowOffer,
  selectTerms,
  termsFromOffer,
  toModelSafeSummary,
  type Address,
  type AuthCaptureRequirements,
  type ModelSafeTerms,
  type PaymentPayload,
  type Terms,
  encodePaymentHeader,
  encodePaymentSignatureHeader,
  decodeSettlementHeader,
  NETWORK_BASE_SEPOLIA,
  SCHEME_EXACT,
  X402_VERSION,
  X402_VERSION_V2,
  type SettleResponse,
} from "@ntux402/shared";

import type { X402Client, FailureReason, FetchOutcome } from "../x402/client.js";
import type { DecisionReader, PollOptions } from "../inco/reveal.js";
import { pollForDecision } from "../inco/reveal.js";
import type { VaultRelay, SpendRequested } from "./relay.js";
import type { AuthorizeOutcome, SignedAuthorization, SignerClient } from "./signer-client.js";

/** No key: nothing yet makes delivery conditional. Signed offers will supply one. */
const NO_KEY_HASH = `0x${"00".repeat(32)}` as const;

/**
 * Why a signature cannot be presented against this offer, or undefined if it can. The
 * signer read its terms from the chain and the offer came from the vendor, and both must
 * describe one payment before it is sent. Not a trust boundary, since the vault re-checks
 * at collection, but a mismatch means something is badly wrong.
 */
function escrowMismatch(signed: SignedAuthorization, offer: AuthCaptureRequirements): string | undefined {
  const payment = signed.payment;
  if (!payment) return "the signer returned no escrow payment: is it running the current code?";
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(payment.operator, offer.extra.captureAuthorizer)) return `operator differs: ${payment.operator}`;
  if (!same(payment.receiver, offer.payTo)) return `receiver differs: ${payment.receiver}`;
  if (!same(payment.token, offer.asset)) return `token differs: ${payment.token}`;
  if (payment.maxAmount !== offer.amount) return `amount differs: ${payment.maxAmount}`;
  if (payment.authorizationExpiry !== offer.extra.captureDeadline) {
    return `capture deadline differs: ${payment.authorizationExpiry}`;
  }
  return undefined;
}

/** How often a pending reveal reports that it is still waiting. */
const REVEAL_WAITING_EVERY_MS = 5_000;

/**
 * The least hold a spend is committed against. What has to fit inside the hold is
 * the time from the request to funding the escrow: on 9 November 2026, over 20 paid
 * calls on the escrow vault, a median of 19.4 s and a maximum of 23.8 s
 * (docs/runs/baseline-bench-*.json). 30 s is that maximum with a margin. It is a
 * heuristic: a slow Inco reveal can still outlast it, and then the approval is
 * reclaimed, not paid late.
 */
const DEFAULT_MIN_HOLD_SECONDS = 30;

/** The longest a failed run waits for its authorization to expire before reclaiming. */
const DEFAULT_RECLAIM_WAIT_MS = 120_000;

/**
 * Past `validBefore` by this machine's clock before reclaiming. A Base block is
 * two seconds, and the vault reads the time of the block it runs in.
 */
const RECLAIM_GRACE_MS = 4_000;

// ------------------------------------------------------------------- events

/**
 * Everything that happens, in order, as structured data. The trace builder
 * and the UI consume this; nothing in the loop formats a string for
 * display. `description` is carried verbatim on the terms event **because** it
 * is the attacker's text and the demo needs to show it. The model reads it as
 * untrusted input; it never reaches a policy check.
 */
export type PaymentEvent =
  | { readonly type: "request"; readonly url: string; readonly attempt: number }
  | { readonly type: "response-200"; readonly url: string; readonly fromCache: boolean }
  | { readonly type: "payment-required"; readonly url: string; readonly terms: Terms }
  | { readonly type: "terms-rejected"; readonly url: string; readonly error: string }
  | {
      readonly type: "agent-reasoning";
      readonly reasoning: string;
      readonly modelSafeTerms: ModelSafeTerms;
      readonly decidedToRequest: boolean;
      readonly source: AgentSource;
    }
  | { readonly type: "spend-requested"; readonly goalId: bigint; readonly spend: SpendRequested }
  | {
      readonly type: "reveal-polled";
      readonly attempts: number;
      readonly latencyMs: number;
      readonly approved: boolean;
    }
  /**
   * Still waiting on Inco, at most every five seconds. `note` is the last thing
   * Inco said, so a dead covalidator shows up as its error while it happens and
   * not only as a timeout minutes later.
   */
  | {
      readonly type: "reveal-waiting";
      readonly attempts: number;
      readonly elapsedMs: number;
      readonly note?: string;
    }
  | { readonly type: "reveal-timeout"; readonly attempts: number; readonly elapsedMs: number }
  | {
      readonly type: "decision-finalized";
      readonly goalId: bigint;
      readonly seq: bigint;
      readonly approved: boolean;
      readonly txHash: `0x${string}`;
      /**
       * The covalidator signatures submitted with this decision.
       *
       * Reported because the trace's attestation is only worth the name if it
       * carries them: a reader holding the file can check them against Inco's
       * verifier without asking this service for anything. They are already
       * public — `e.reveal` made the handle readable by anyone — so emitting
       * them discloses nothing that was not already fetchable.
       */
      readonly signatures: readonly `0x${string}`[];
    }
  | {
      readonly type: "orphan-recovered";
      readonly seq: bigint;
      readonly approved: boolean;
      readonly txHash: `0x${string}`;
    }
  | { readonly type: "orphan-abandoned"; readonly seq: bigint; readonly reason: string }
  | { readonly type: "signer-refused"; readonly status: number; readonly reason: string }
  | { readonly type: "signed"; readonly nonce: `0x${string}`; readonly value: string }
  | { readonly type: "settled"; readonly settlement: SettleResponse }
  /**
   * What became of an approved amount that was not paid.
   *
   *   - `waiting`: its authorization is still usable, until `validBefore`, and
   *     the run waits for that before reclaiming.
   *   - `reclaimed`: its authorization expired unused, and the budget and the
   *     call came back.
   *   - `collected`: the token consumed the authorization, so the money left the
   *     payer even though this run did not get what it paid for.
   *   - `deferred`: the authorization is still usable until `validBefore`, later
   *     than this run waits. `pnpm --filter @ntux402/e2e run reclaim` finishes it.
   *   - `failed`: the reclaim did not go through; `reason` says why.
   */
  | {
      readonly type: "reclaim";
      readonly goalId: bigint;
      readonly seq: bigint;
      readonly outcome: "waiting" | "reclaimed" | "collected" | "deferred" | "failed";
      readonly validBefore: bigint;
      readonly txHash?: `0x${string}`;
      readonly reason?: string;
    }
  | { readonly type: "failed"; readonly reason: string };

// ------------------------------------------------------------------ outcomes

export type PaymentResult =
  | { readonly kind: "free"; readonly data: unknown }
  | {
      readonly kind: "paid";
      readonly data: unknown;
      readonly goalId: bigint;
      readonly seq: bigint;
      readonly terms: Terms;
      readonly settlement: SettleResponse | undefined;
    }
  /** The confidential policy said no. The bounce — visible, not swallowed. */
  | {
      readonly kind: "policy-rejected";
      readonly goalId: bigint;
      readonly seq: bigint;
      readonly terms: Terms;
      readonly decisionHandle: `0x${string}`;
      readonly commitTx: `0x${string}`;
    }
  /** Debit committed, decision unobtainable. Distinct from a rejection. */
  | {
      readonly kind: "decision-unavailable";
      readonly goalId: bigint;
      readonly seq: bigint;
      readonly attempts: number;
      readonly elapsedMs: number;
    }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Who produced a spend decision.
 *
 * `scripted-fallback` is deliberately not folded into `scripted`: it means the
 * gateway was configured and could not answer, which is a different fact about
 * the run than having chosen the offline agent, and the trace has to be able to
 * say which one happened.
 */
export type AgentSource = "llm" | "scripted" | "scripted-fallback";

/** How the agent reacts to a 402. See `agent/` for the implementations. */
export interface SpendAgent {
  consider(terms: ModelSafeTerms, rawDescription: string): Promise<{
    reasoning: string;
    proceed: boolean;
    source: AgentSource;
  }>;
}

export interface PaymentLoopConfig {
  readonly client: X402Client;
  readonly relay: VaultRelay;
  readonly decisions: DecisionReader;
  readonly signer: SignerClient;
  readonly agent: SpendAgent;
  readonly asset: Address;
  readonly network?: string;
  /**
   * Set when the vault is an EscrowPolicyVault, which can only pay through x402 v2
   * `auth-capture`. This run's configuration decides the flow, never the vendor: a 402
   * offering the other kind is refused, because neither kind can be paid on the wrong vault.
   */
  readonly escrow?: { readonly vault: Address; readonly network: string };
  readonly poll?: PollOptions;
  /** How long to keep asking the signer while the chain read catches up. */
  readonly signerRetries?: number;
  /** The least of the vendor's hold that must be left to commit a spend. */
  readonly minHoldSeconds?: number;
  /** The longest a failed run waits for its authorization to expire. */
  readonly reclaimWaitMs?: number;
  /** Milliseconds since the epoch. Tests replace it. */
  readonly now?: () => number;
  /** Tests replace it, so a wait for expiry does not take real time. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onEvent?: (event: PaymentEvent) => void;
}

export class PaymentLoop {
  readonly #config: PaymentLoopConfig;
  readonly #listeners = new Set<(event: PaymentEvent) => void>();

  constructor(config: PaymentLoopConfig) {
    this.#config = config;
  }

  /**
   * Adds a process-wide listener, and returns its remover.
   *
   * Process-wide is the whole meaning of it: this sink sees *every* run, which
   * is right for the CLI renderer and wrong for anything serving one caller.
   * A per-run sink goes to `fetchPaid`, not here.
   *
   * A listener that throws must not derail a payment, so each is called
   * defensively.
   */
  subscribe(listener: (event: PaymentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Fans one event out to the process-wide sinks and to the run that produced
   * it. `run` is the per-call listener; it never sees another run's events
   * because it does not outlive the `fetchPaid` frame that created it.
   */
  #emit(event: PaymentEvent, run?: ((event: PaymentEvent) => void) | undefined): void {
    this.#config.onEvent?.(event);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* a broken listener is not a reason to abandon a spend in flight */
      }
    }
    if (run) {
      try {
        run(event);
      } catch {
        /* same, for the caller's own sink */
      }
    }
  }

  /**
   * Fetches `url`, paying for it if the server demands payment and the
   * confidential policy allows it.
   *
   * ## `options.onEvent`, and why it is not `subscribe`
   *
   * One `PaymentLoop` serves the whole process, so a listener registered on the
   * instance receives events from *every* concurrent run. The HTTP server used
   * to subscribe per request, which meant two simultaneous runs each streamed
   * the other's events to the wrong browser — and, worse, each `TraceBuilder`
   * recorded both goals' steps, producing traces that were wrong rather than
   * merely noisy. A trace is the evidence artifact; silently interleaving two
   * of them is the most damaging bug this file could have.
   *
   * The sink is therefore a parameter of the call, scoped to exactly the run
   * that owns it. Nothing needs unsubscribing, because nothing outlives the
   * frame.
   *
   * ## `options.fresh`, and why a repeat run must be able to pay again
   *
   * The response cache lives on the `X402Client`, which lives as long as the
   * process. That is right for a *retry* — a run re-issued after a blip must
   * not pay twice — and wrong for a *deliberate repeat purchase*, which is what
   * every click of the console's run button is. Left to the cache, the second
   * run of a resource returned `kind: "free"` before reaching `requestSpend`:
   * no chain write, no debit, no settlement, and a budget that visibly did not
   * move while the UI promised it would.
   *
   * The two are indistinguishable from the URL, so the caller declares which it
   * is. Callers that re-issue a run on failure keep the default and stay
   * protected; the server passes `fresh` because a human asked for the thing
   * again and expects to be charged for it.
   */
  async fetchPaid(
    url: string,
    goalId: bigint,
    options: {
      readonly onEvent?: (event: PaymentEvent) => void;
      /** Treat this as a new purchase rather than a retry. See above. */
      readonly fresh?: boolean;
    } = {},
  ): Promise<PaymentResult> {
    const { client, relay, signer, agent } = this.#config;
    const network = this.#config.network ?? NETWORK_BASE_SEPOLIA;
    // Bound to this call. Every emit below goes through it.
    const emit = (event: PaymentEvent) => this.#emit(event, options.onEvent);

    emit({ type: "request", url, attempt: 1 });
    const first: FetchOutcome = await client.fetchResource(
      url,
      options.fresh === true ? { fresh: true } : {},
    );
    // A 402 starts the vendor's hold. Everything from here on spends it.
    const quotedAt = this.#now();

    if (first.kind === "ok") {
      emit({ type: "response-200", url, fromCache: first.fromCache });
      return { kind: "free", data: first.body };
    }
    if (first.kind === "failed") {
      const reason = describeFailure(first.reason);
      emit({ type: "failed", reason });
      return { kind: "failed", reason };
    }

    // --- 402: typed terms, not instructions --------------------------------
    const escrow = this.#config.escrow;
    if ((first.kind === "escrow-payment-required") !== (escrow !== undefined)) {
      const error = escrow
        ? "this vault pays only through x402 auth-capture, and the vendor did not offer it"
        : "the vendor offered x402 auth-capture, and this vault cannot pay through it";
      emit({ type: "terms-rejected", url, error });
      return { kind: "failed", reason: error };
    }

    let terms: Terms;
    let offer: AuthCaptureRequirements | undefined;
    if (first.kind === "escrow-payment-required") {
      const selected = selectEscrowOffer(first.parsed, {
        network: escrow!.network,
        asset: this.#config.asset,
        operator: escrow!.vault,
      });
      if (!selected.ok) {
        emit({ type: "terms-rejected", url, error: selected.error });
        return { kind: "failed", reason: selected.error };
      }
      offer = selected.value;
      terms = termsFromOffer(offer, first.parsed);
    } else {
      const selected = selectTerms(first.parsed, { network, asset: this.#config.asset });
      if (!selected.ok) {
        emit({ type: "terms-rejected", url, error: selected.error });
        return { kind: "failed", reason: selected.error };
      }
      terms = selected.value;
    }
    emit({ type: "payment-required", url, terms });

    // --- the agent reads the attacker's text -------------------------------
    // Deliberate, and the centre of the demo. The model may be convinced of
    // anything at all here; the most it can do about it is call `requestSpend`.
    const thought = await agent.consider(toModelSafeSummary(terms), terms.description);
    emit({
      type: "agent-reasoning",
      reasoning: thought.reasoning,
      modelSafeTerms: toModelSafeSummary(terms),
      decidedToRequest: thought.proceed,
      source: thought.source,
    });
    if (!thought.proceed) {
      return { kind: "failed", reason: "agent declined to request the spend" };
    }

    // --- clear any orphan left by a crashed run ----------------------------
    // `pendingSeq` is set by `requestSpend` and cleared only by
    // `finalizeDecision`. A process that dies between the two leaves the goal
    // permanently wedged: every later `requestSpend` reverts `SpendPending()`,
    // and nothing in the system was putting it right. The decision is still
    // retrievable and `finalizeDecision` is permissionless, so recovery is
    // simply doing what the dead run would have done.
    const recovery = await this.#recoverOrphan(goalId, emit);
    if (recovery !== undefined) return recovery;

    // --- the vendor's hold ---------------------------------------------------
    // The authorization will end where the hold does. With too little of it
    // left the payment would expire on the way, so stop before committing a
    // debit for something the vendor is about to release.
    const payBy = BigInt(Math.floor(quotedAt / 1_000) + terms.maxTimeoutSeconds);
    const minHold = this.#config.minHoldSeconds ?? DEFAULT_MIN_HOLD_SECONDS;
    const holdLeft = Number(payBy) - Math.floor(this.#now() / 1_000);
    if (holdLeft < minHold) {
      const reason =
        `the vendor holds this for ${terms.maxTimeoutSeconds}s and ${Math.max(holdLeft, 0)}s ` +
        `are left, less than the ${minHold}s a paid call needs. Nothing was committed; ` +
        `ask again for a fresh hold.`;
      emit({ type: "failed", reason });
      return { kind: "failed", reason };
    }

    // --- commit ------------------------------------------------------------
    let spend: SpendRequested;
    try {
      spend = offer
        ? await relay.requestEscrowSpend(
            goalId,
            terms.amount,
            terms.payTo,
            terms.resource,
            payBy,
            offer.extra.captureDeadline,
            NO_KEY_HASH,
          )
        : await relay.requestSpend(goalId, terms.amount, terms.payTo, terms.resource, payBy);
    } catch (e) {
      const reason = `requestSpend failed: ${e instanceof Error ? e.message : String(e)}`;
      emit({ type: "failed", reason });
      return { kind: "failed", reason };
    }
    emit({ type: "spend-requested", goalId, spend });

    // --- retrieve the decision ---------------------------------------------
    let reportedAt = 0;
    const poll = await pollForDecision(this.#config.decisions, spend.decisionHandle, {
      ...this.#config.poll,
      onAttempt: (attempt, elapsedMs, note) => {
        this.#config.poll?.onAttempt?.(attempt, elapsedMs, note);
        if (elapsedMs - reportedAt < REVEAL_WAITING_EVERY_MS) return;
        reportedAt = elapsedMs;
        emit({
          type: "reveal-waiting",
          attempts: attempt,
          elapsedMs,
          ...(note === undefined ? {} : { note }),
        });
      },
    });

    if (poll.kind === "timeout") {
      emit({ type: "reveal-timeout", attempts: poll.attempts, elapsedMs: poll.elapsedMs });
      return {
        kind: "decision-unavailable",
        goalId,
        seq: spend.seq,
        attempts: poll.attempts,
        elapsedMs: poll.elapsedMs,
      };
    }

    const approved = poll.decision.approved;
    emit({
      type: "reveal-polled",
      attempts: poll.attempts,
      latencyMs: poll.latencyMs,
      approved,
    });

    // --- finalize ------------------------------------------------------------
    // Submitted even when rejected: the bounce belongs on chain and in the
    // trace, and `finalizeDecision` is what clears `pendingSeq` so the goal can
    // be used again.
    let finalizeTx: `0x${string}`;
    try {
      const result = await relay.finalizeDecision(
        goalId,
        spend.seq,
        approved,
        poll.decision.signatures,
      );
      finalizeTx = result.txHash;
    } catch (e) {
      const reason = `finalizeDecision failed: ${e instanceof Error ? e.message : String(e)}`;
      emit({ type: "failed", reason });
      return { kind: "failed", reason };
    }
    emit({
      type: "decision-finalized",
      goalId,
      seq: spend.seq,
      approved,
      txHash: finalizeTx,
      signatures: poll.decision.signatures,
    });

    if (!approved) {
      return {
        kind: "policy-rejected",
        goalId,
        seq: spend.seq,
        terms,
        decisionHandle: spend.decisionHandle,
        commitTx: spend.commitTx,
      };
    }

    // --- authorize -----------------------------------------------------------
    const authorization = await this.#authorizeWithRetry(goalId, spend.seq);
    if (authorization.kind !== "signed") {
      const reason =
        authorization.kind === "refused"
          ? authorization.reason
          : `signer ${authorization.kind}: ${authorization.reason}`;
      emit({
        type: "signer-refused",
        // Reaching here with `rate-limited` means the retry budget above was
        // spent and the limiter never cleared. Reported as the 429 it is, so
        // the console does not show a limit as an unexplained status 0.
        status:
          authorization.kind === "refused"
            ? authorization.status
            : authorization.kind === "rate-limited"
              ? 429
              : 0,
        reason,
      });
      await this.#reclaim(goalId, spend.seq, spend.validBefore, emit, { wait: true });
      return { kind: "failed", reason };
    }

    const signed = authorization.value;
    emit({
      type: "signed",
      nonce: signed.authorization.nonce,
      value: signed.authorization.value,
    });

    // Cross-check what we are about to send against what the vault froze. Not a
    // trust boundary — the signer already read the chain — but a mismatch here
    // means something is badly wrong and paying anyway would compound it.
    if (signed.termsHash !== spend.termsHash) {
      const reason =
        `termsHash mismatch: signer signed against ${signed.termsHash}, ` +
        `requestSpend recorded ${spend.termsHash}`;
      emit({ type: "failed", reason });
      await this.#reclaim(goalId, spend.seq, spend.validBefore, emit, { wait: true });
      return { kind: "failed", reason };
    }

    // --- pay and retry --------------------------------------------------------
    let requestOptions: { payment: string } | { escrowPayment: string };
    if (offer) {
      const mismatch = escrowMismatch(signed, offer);
      if (mismatch) {
        const reason = `the signed payment does not match the vendor's offer: ${mismatch}`;
        emit({ type: "failed", reason });
        await this.#reclaim(goalId, spend.seq, spend.validBefore, emit, { wait: true });
        return { kind: "failed", reason };
      }
      requestOptions = {
        escrowPayment: encodePaymentSignatureHeader({
          x402Version: X402_VERSION_V2,
          resource: { url: terms.resource, method: "GET" },
          accepted: offer,
          payload: {
            authorization: signed.authorization,
            signature: signed.signature,
            salt: saltToHex(BigInt(signed.payment!.salt)),
          },
        }),
      };
    } else {
      const payload: PaymentPayload = {
        x402Version: X402_VERSION,
        scheme: SCHEME_EXACT,
        network,
        payload: {
          signature: signed.signature,
          authorization: signed.authorization,
        },
      };
      requestOptions = { payment: encodePaymentHeader(payload) };
    }

    emit({ type: "request", url, attempt: 2 });
    const paid = await client.fetchResource(url, requestOptions);

    if (paid.kind !== "ok") {
      /*
       * A second 402 means the payment was presented and refused, and the
       * resource server puts the facilitator reason in the body. Reporting the
       * bare fact ("still demands payment") threw that away and left every
       * settlement failure looking identical -- an unfunded payer, an expired
       * authorization and an unreachable facilitator all surfaced as the same
       * sentence, twenty seconds into a run, with the real answer already on
       * the wire.
       *
       * But that string is written by the vendor, and on this project the
       * vendor is assumed hostile. Passed through bare it became the body of
       * the console's "Run failed" panel, in the console's own voice -- so a
       * vendor could have the UI tell the operator "settlement succeeded,
       * raise your budget and retry". It changes no number and reaches no
       * policy, but the demo's whole register is that attacker text is shown
       * as *quoted*, never absorbed. `attributeVendorText` puts it back in
       * quotation marks where it belongs.
       */
      const reason =
        paid.kind === "failed"
          ? describeFailure(paid.reason)
          : paid.parsed.error !== undefined
            ? attributeVendorText(paid.parsed.error)
            : "resource still demands payment after settlement";
      emit({ type: "failed", reason });
      // The vendor holds the authorization and may still collect it, honestly
      // or not, until it expires. The vault checks which happened.
      await this.#reclaim(goalId, spend.seq, spend.validBefore, emit, { wait: true });
      return { kind: "failed", reason };
    }

    let settlement: SettleResponse | undefined;
    if (paid.paymentResponse) {
      const decoded = decodeSettlementHeader(paid.paymentResponse);
      if (decoded.ok) {
        settlement = decoded.value;
        emit({ type: "settled", settlement });
      }
    }

    emit({ type: "response-200", url, fromCache: paid.fromCache });
    return { kind: "paid", data: paid.body, goalId, seq: spend.seq, terms, settlement };
  }

  /**
   * The signer reads the chain, and the chain we just wrote to may not be
   * visible on the node it reads from yet. A 425 is "ask again", so ask again —
   * bounded. Any other refusal is final and returned immediately.
   */
  /**
   * Finalises a spend an earlier run committed and abandoned.
   *
   * Returns undefined when there was nothing to do — the overwhelmingly common
   * case — or a `PaymentResult` when the goal cannot proceed and the caller
   * should stop.
   *
   * ## Why this is safe to do unprompted
   *
   * It finalises a decision that already exists on chain; it does not create
   * one. The debit committed when the orphan was requested, so the money has
   * already moved regardless of whether anyone finalises it. Refusing to
   * recover would not un-spend it — it would only leave the goal unusable and
   * the record permanently incomplete.
   *
   * The orphan's own outcome is deliberately *not* returned as this run's
   * result. It belonged to a different request, and reporting a previous run's
   * approval as though this caller had earned it would be a lie about what just
   * happened. It is reported as its own event and the current run proceeds.
   */
  async #recoverOrphan(
    goalId: bigint,
    emit: (event: PaymentEvent) => void,
  ): Promise<PaymentResult | undefined> {
    const { relay } = this.#config;

    let pending: bigint;
    try {
      pending = await relay.pendingSeq(goalId);
    } catch {
      // A read failure here is not itself fatal: `requestSpend` below will
      // surface any real chain problem with a better message.
      return undefined;
    }
    if (pending === 0n) return undefined;

    // A seq this relay already finalized is not an orphan: the read came from a
    // node behind our own receipt. Re-finalizing it reverts AlreadyFinalized,
    // which a 50-call benchmark on 12 October 2026 hit four times in twenty.
    // Wait for the node to catch up instead; requestSpend's own stale-refusal
    // retry covers whatever lag remains.
    if (relay.hasFinalized(goalId, pending)) {
      await relay
        .waitUntilVisible(
          `finalization of ${goalId}:${pending}`,
          async () => (await relay.pendingSeq(goalId)) !== pending,
          30_000,
        )
        .catch(() => undefined);
      return undefined;
    }

    const abandon =(reason: string): PaymentResult => {
      emit({ type: "orphan-abandoned", seq: pending, reason });
      return { kind: "failed", reason };
    };

    let handle: `0x${string}`;
    try {
      handle = await relay.decisionHandle(goalId, pending);
    } catch (e) {
      return abandon(
        `goal ${goalId} has an unfinalized spend at seq ${pending} and its decision handle ` +
          `could not be read: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const poll = await pollForDecision(this.#config.decisions, handle, { ...this.#config.poll });
    if (poll.kind === "timeout") {
      /*
       * `lastError` is the whole point of this message.
       *
       * Without it the operator is told the decision is unavailable and not one
       * word about why, and "Inco's covalidator cannot reach an RPC" reads
       * exactly like "the decision was never produced". `pollForDecision`
       * returns it precisely so the caller can say which — see its header on
       * why the timeout is an outcome rather than a throw — and dropping it
       * here cost an hour of diagnosis that the log already had the answer to.
       */
      return abandon(
        `goal ${goalId} is blocked by an unfinalized spend at seq ${pending}, and its decision ` +
          `is still not retrievable after ${poll.attempts} attempts. The goal cannot accept a new ` +
          `spend until it is finalized. Last error: ${poll.lastError ?? "none reported"}.`,
      );
    }

    try {
      const { txHash } = await relay.finalizeDecision(
        goalId,
        pending,
        poll.decision.approved,
        poll.decision.signatures,
      );
      emit({
        type: "orphan-recovered",
        seq: pending,
        approved: poll.decision.approved,
        txHash,
      });
    } catch (e) {
      return abandon(
        `goal ${goalId} is blocked by an unfinalized spend at seq ${pending} and finalizing it ` +
          `failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // The run that requested it died before signing, so an approved orphan was
    // never paid. Usually Inco was slow, and the vendor's hold has long gone.
    // Not waited for: this run has its own hold to keep.
    if (poll.decision.approved) {
      let validBefore: bigint | undefined;
      try {
        ({ validBefore } = await relay.validityWindow(goalId, pending));
      } catch {
        // Unreadable now. The reclaim tool finds it later; this run goes on.
      }
      if (validBefore !== undefined) {
        await this.#reclaim(goalId, pending, validBefore, emit, { wait: false });
      }
    }
    return undefined;
  }

  /**
   * Gives an approved, unpaid amount back to the budget once its authorization
   * can no longer be used.
   *
   * The vault decides, not this process. It refuses while the window is open
   * and once the token has consumed the authorization, so this is safe after
   * any failure that follows an approval, and the outcome reports what really
   * happened to the money: `collected` means a vendor took it.
   *
   * With `wait`, a window that closes within `reclaimWaitMs` is waited out. A
   * later one is reported `deferred` and left to the `reclaim` tool.
   */
  async #reclaim(
    goalId: bigint,
    seq: bigint,
    validBefore: bigint,
    emit: (event: PaymentEvent) => void,
    options: { readonly wait: boolean },
  ): Promise<void> {
    const report = (
      outcome: "waiting" | "reclaimed" | "collected" | "deferred" | "failed",
      extra: { readonly txHash?: `0x${string}`; readonly reason?: string } = {},
    ) => emit({ type: "reclaim", goalId, seq, outcome, validBefore, ...extra });

    const untilExpiredMs = Number(validBefore) * 1_000 + RECLAIM_GRACE_MS - this.#now();
    if (untilExpiredMs > 0) {
      const limit = options.wait ? (this.#config.reclaimWaitMs ?? DEFAULT_RECLAIM_WAIT_MS) : 0;
      if (untilExpiredMs > limit) {
        report("deferred");
        return;
      }
      report("waiting");
      await this.#sleep(untilExpiredMs);
    }

    try {
      const result = await this.#config.relay.reclaimExpired(goalId, seq);
      switch (result.kind) {
        case "reclaimed":
          report("reclaimed", { txHash: result.txHash });
          return;
        case "already":
          report("reclaimed", { reason: "another caller reclaimed it first" });
          return;
        case "collected":
          report("collected");
          return;
        case "live":
          report("deferred", { reason: "the vault still reads the authorization as usable" });
          return;
      }
    } catch (e) {
      report("failed", { reason: e instanceof Error ? e.message : String(e) });
    }
  }

  #now(): number {
    return this.#config.now?.() ?? Date.now();
  }

  async #sleep(ms: number): Promise<void> {
    if (this.#config.sleep) return this.#config.sleep(ms);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Polls the signer until it answers something other than "ask again".
   *
   * Two outcomes mean that, and both are retried here rather than surfaced:
   *
   *   - `not-ready` (425) — the decision is committed but `finalizeDecision`
   *     has not landed. Fixed 1s, because it clears on the next block.
   *   - `rate-limited` (429) — a limiter tripped, at the signer's HTTP edge or
   *     on its enclave key operations. Waits what the signer asked for.
   *
   * The retry-after is capped at 10s per attempt even though the client already
   * clamps it to 60. A single 60s sleep would eat five attempts' worth of the
   * budget in one go and leave the loop looking hung; the signer's window is
   * fixed at a minute, so several shorter waits land on the reset just as
   * surely and keep the worst case bounded and legible.
   *
   * Retrying at all is the point. The budget for this spend is already debited
   * on chain by the time we get here, so giving up on a limiter that clears in
   * seconds would strand it.
   */
  async #authorizeWithRetry(goalId: bigint, seq: bigint): Promise<AuthorizeOutcome> {
    const attempts = this.#config.signerRetries ?? 12;
    let last: AuthorizeOutcome = { kind: "not-ready", reason: "not attempted" };
    for (let i = 0; i < attempts; i++) {
      last = await this.#config.signer.authorize(goalId, seq);
      if (last.kind !== "not-ready" && last.kind !== "rate-limited") return last;

      // A signer that sent no usable retry-after reports 0, which must not
      // become a busy loop against the thing already asking us to slow down.
      const asked = last.kind === "rate-limited" ? last.retryAfterSeconds : 0;
      const waitSeconds = Math.min(Math.max(asked, 1), 10);
      await new Promise((r) => setTimeout(r, waitSeconds * 1_000));
    }
    return last;
  }
}

/** Longest run of vendor prose worth repeating. Beyond this it is a flood. */
const VENDOR_TEXT_MAX = 200;

/**
 * Renders vendor-written text as an attributed quotation.
 *
 * Three things, each guarding a different failure:
 *
 *  - **Attribution.** The reason is displayed as the console's account of what
 *    happened, so text arriving from a hostile vendor has to be visibly theirs
 *    rather than ours.
 *  - **Control characters removed.** Newlines and escapes let a vendor forge
 *    log structure, or fake a second line of output in a terminal renderer.
 *  - **Length capped.** A refusal reason is a sentence; anything longer is
 *    either a mistake or an attempt to push the real content out of view.
 */
export function attributeVendorText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const flattened = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const clipped =
    flattened.length > VENDOR_TEXT_MAX
      ? `${flattened.slice(0, VENDOR_TEXT_MAX)}…`
      : flattened;
  return clipped === ""
    ? "the resource server refused the payment without saying why"
    : `the resource server refused the payment and said: "${clipped}"`;
}

function describeFailure(reason: FailureReason): string {
  switch (reason.type) {
    case "malformed-402":
      return `malformed 402 rejected: ${reason.error}`;
    case "invalid-json":
      return `invalid JSON: ${reason.error}`;
    case "http-error":
      return `HTTP ${reason.status}`;
    case "network-error":
      return `network error: ${reason.error}`;
    case "retries-exhausted":
      return `retries exhausted after ${reason.attempts} (last: ${
        reason.lastError ?? reason.lastStatus ?? "unknown"
      })`;
  }
}
