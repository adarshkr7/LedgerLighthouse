/**
 * Builds a trace from the orchestrator's event stream.
 *
 * The builder is a *consumer*: the payment loop emits structured events and
 * never formats anything for a trace, so the trace format can change without
 * touching the payment path — and, more importantly, so the trace records what
 * actually happened rather than what a logging call said happened.
 *
 * Deliberately duplicated rather than imported: `services/trace` does not
 * depend on `services/orchestrator`. The verifier has to run "with no
 * dependency on your services beyond a public RPC" (ARCHITECTURE.md §8.4), and a verifier
 * that imports the orchestrator is not that. The structural type below is the
 * seam.
 */

import type { Hex } from "viem";

import { hashPayload } from "./canonical.js";
import { merkleRoot } from "./merkle.js";
import {
  GENESIS_HASH,
  computeStepHash,
  type StepAttestation,
  type StepType,
  type Trace,
  type TraceStep,
} from "./step.js";

/** The shape consumed from the orchestrator, declared structurally. */
export interface IncomingEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface TraceBuilderOptions {
  readonly goalId: bigint | string;
  readonly vault: Hex;
  readonly chainId: number;
  /** Injectable so tests produce a byte-stable trace. */
  readonly now?: () => number;
}

export class TraceBuilder {
  readonly #steps: TraceStep[] = [];
  readonly #options: TraceBuilderOptions;
  readonly #now: () => number;

  /** Carried across events so the reveal and finalize steps can cite the commit. */
  #pending:
    | {
        seq: string;
        decisionHandle: Hex;
        commitTx: Hex;
        signatures: readonly Hex[];
        approved?: boolean;
      }
    | undefined;

  constructor(options: TraceBuilderOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get steps(): readonly TraceStep[] {
    return this.#steps;
  }

  /** Appends a step and links it into the chain. */
  append(
    type: StepType,
    inputs: unknown,
    outputs: unknown,
    attestation?: StepAttestation,
  ): TraceStep {
    const priorHash = this.#steps.at(-1)?.hash ?? GENESIS_HASH;
    const partial = {
      index: this.#steps.length,
      type,
      timestamp: this.#now(),
      inputs,
      outputs,
      priorHash,
      ...(attestation ? { attestation } : {}),
    };
    const step: TraceStep = { ...partial, hash: computeStepHash(partial) };
    this.#steps.push(step);
    return step;
  }

  /** Translates one orchestrator event. Unknown event types are ignored. */
  record(event: IncomingEvent): void {
    switch (event.type) {
      case "request":
        this.append("request", { url: event["url"], attempt: event["attempt"] }, null);
        break;

      case "payment-required": {
        const terms = event["terms"] as Record<string, unknown>;
        this.append(
          "payment-required",
          { url: event["url"] },
          {
            // The vendor's text is recorded verbatim. It is evidence, and the
            // demo turns on being able to show exactly what was sent.
            amount: terms["amount"],
            payTo: terms["payTo"],
            asset: terms["asset"],
            resource: terms["resource"],
            description: terms["description"],
          },
        );
        break;
      }

      case "terms-rejected":
        this.append("terms-rejected", { url: event["url"] }, { error: event["error"] });
        break;

      case "agent-reasoning":
        this.append(
          "agent-reasoning",
          { modelSafeTerms: event["modelSafeTerms"], source: event["source"] },
          { reasoning: event["reasoning"], decidedToRequest: event["decidedToRequest"] },
        );
        break;

      case "spend-requested": {
        const spend = event["spend"] as Record<string, unknown>;
        this.#pending = {
          seq: String(spend["seq"]),
          decisionHandle: spend["decisionHandle"] as Hex,
          commitTx: spend["commitTx"] as Hex,
          signatures: [],
        };
        this.append(
          "spend-requested",
          { goalId: String(event["goalId"]), amount: spend["amount"] },
          {
            seq: String(spend["seq"]),
            termsHash: spend["termsHash"],
            decisionHandle: spend["decisionHandle"],
            validAfter: String(spend["validAfter"]),
            validBefore: String(spend["validBefore"]),
            commitTx: spend["commitTx"],
          },
        );
        break;
      }

      case "reveal-polled":
        this.append(
          "decision-revealed",
          { attempts: event["attempts"] },
          { approved: event["approved"], latencyMs: event["latencyMs"] },
        );
        break;

      case "reveal-timeout":
        this.append(
          "failed",
          { attempts: event["attempts"] },
          {
            reason: "decision unavailable — the debit committed but the reveal never resolved",
            elapsedMs: event["elapsedMs"],
          },
        );
        break;

      case "decision-finalized": {
        const approved = Boolean(event["approved"]);
        const pending = this.#pending;
        this.append(
          "decision-finalized",
          { goalId: String(event["goalId"]), seq: String(event["seq"]) },
          { approved, txHash: event["txHash"] },
          pending
            ? {
                decisionHandle: pending.decisionHandle,
                covalidatorSignatures: pending.signatures,
                commitTx: pending.commitTx,
                finalizeTx: event["txHash"] as Hex,
                goalId: String(event["goalId"]),
                seq: String(event["seq"]),
                approved,
              }
            : undefined,
        );
        break;
      }

      case "signer-refused":
        this.append(
          "signer-refused",
          { status: event["status"] },
          { reason: event["reason"] },
        );
        break;

      case "signed":
        this.append("authorization-signed", null, {
          nonce: event["nonce"],
          value: event["value"],
        });
        break;

      case "settled":
        this.append("settled", null, event["settlement"]);
        break;

      case "response-200":
        this.append("response", { url: event["url"] }, { fromCache: event["fromCache"] });
        break;

      case "failed":
        this.append("failed", null, { reason: event["reason"] });
        break;

      default:
        break;
    }
  }

  /**
   * Attaches the covalidator signatures for the spend currently in flight.
   *
   * Separate from `record` because the orchestrator's event stream does not
   * carry them — they are bytes it passes to `finalizeDecision`, not something
   * it reports. The demo driver hands them over explicitly.
   */
  attachSignatures(signatures: readonly Hex[]): void {
    if (this.#pending) this.#pending = { ...this.#pending, signatures };
  }

  build(): Trace {
    return {
      version: 1,
      goalId: String(this.#options.goalId),
      vault: this.#options.vault,
      chainId: this.#options.chainId,
      steps: [...this.#steps],
      root: merkleRoot(this.#steps.map((step) => step.hash)),
    };
  }
}

/** Stable digest of a whole trace — handy for a quick equality check. */
export function traceDigest(trace: Trace): Hex {
  return hashPayload({
    version: trace.version,
    goalId: trace.goalId,
    vault: trace.vault,
    chainId: trace.chainId,
    root: trace.root,
  });
}
