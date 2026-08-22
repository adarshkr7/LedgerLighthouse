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
 * rejection and retrying is the anti-pattern in IMPLEMENTATION.md §8 — the bounce is the
 * product, so it is returned as a first-class outcome and surfaced.
 *
 * **A reveal timeout is not a rejection.** The debit committed at
 * `requestSpend`. If the compute server stalls, the budget has moved and the
 * decision is unobtainable — a distinct, reportable state (ARCHITECTURE.md §7.7). Merging
 * it into "rejected" would be a lie about where the money went.
 */

import {
  selectTerms,
  toModelSafeSummary,
  type Address,
  type ModelSafeTerms,
  type PaymentPayload,
  type Terms,
  encodePaymentHeader,
  decodeSettlementHeader,
  NETWORK_BASE_SEPOLIA,
  SCHEME_EXACT,
  X402_VERSION,
  type SettleResponse,
} from "@ntux402/shared";

import type { X402Client, FailureReason, FetchOutcome } from "../x402/client.js";
import type { DecisionReader, PollOptions } from "../inco/reveal.js";
import { pollForDecision } from "../inco/reveal.js";
import type { VaultRelay, SpendRequested } from "./relay.js";
import type { AuthorizeOutcome, SignerClient } from "./signer-client.js";

// ------------------------------------------------------------------- events

/**
 * Everything that happens, in order, as structured data. The trace builder
 * and the UI consume this; nothing in the loop formats a string for
 * display. `description` is carried verbatim on the terms event **because** it
 * is the attacker's text and the demo needs to show it — it just never reaches
 * a model or a policy check.
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
  readonly poll?: PollOptions;
  /** How long to keep asking the signer while the chain read catches up. */
  readonly signerRetries?: number;
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
    const selected = selectTerms(first.parsed, { network, asset: this.#config.asset });
    if (!selected.ok) {
      emit({ type: "terms-rejected", url, error: selected.error });
      return { kind: "failed", reason: selected.error };
    }
    const terms = selected.value;
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

    // --- commit ------------------------------------------------------------
    let spend: SpendRequested;
    try {
      spend = await relay.requestSpend(goalId, terms.amount, terms.payTo, terms.resource);
    } catch (e) {
      const reason = `requestSpend failed: ${e instanceof Error ? e.message : String(e)}`;
      emit({ type: "failed", reason });
      return { kind: "failed", reason };
    }
    emit({ type: "spend-requested", goalId, spend });

    // --- retrieve the decision ---------------------------------------------
    const poll = await pollForDecision(this.#config.decisions, spend.decisionHandle, {
      ...this.#config.poll,
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
        status: authorization.kind === "refused" ? authorization.status : 0,
        reason,
      });
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
      return { kind: "failed", reason };
    }

    // --- pay and retry --------------------------------------------------------
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      scheme: SCHEME_EXACT,
      network,
      payload: {
        signature: signed.signature,
        authorization: signed.authorization,
      },
    };

    emit({ type: "request", url, attempt: 2 });
    const paid = await client.fetchResource(url, { payment: encodePaymentHeader(payload) });

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

    const abandon = (reason: string): PaymentResult => {
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
      return abandon(
        `goal ${goalId} is blocked by an unfinalized spend at seq ${pending}, and its decision ` +
          `is still not retrievable after ${poll.attempts} attempts. The goal cannot accept a new ` +
          `spend until it is finalized.`,
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
      return undefined;
    } catch (e) {
      return abandon(
        `goal ${goalId} is blocked by an unfinalized spend at seq ${pending} and finalizing it ` +
          `failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async #authorizeWithRetry(goalId: bigint, seq: bigint): Promise<AuthorizeOutcome> {
    const attempts = this.#config.signerRetries ?? 12;
    let last: AuthorizeOutcome = { kind: "not-ready", reason: "not attempted" };
    for (let i = 0; i < attempts; i++) {
      last = await this.#config.signer.authorize(goalId, seq);
      if (last.kind !== "not-ready") return last;
      await new Promise((r) => setTimeout(r, 1_000));
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
