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
 * dependency on your services beyond a public RPC" (ARCHITECTURE.md), and a verifier
 * that imports the orchestrator is not that. The structural type below is the
 * seam.
 */

import { sha256, toHex, type Hex } from "viem";

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
                // The bytes the orchestrator handed `finalizeDecision`, carried
                // on the event itself. They used to arrive through a separate
                // `attachSignatures` call that only the tests ever made, so
                // every trace this system actually produced recorded an empty
                // array — an attestation with no attestation in it.
                covalidatorSignatures: hexArray(event["signatures"]),
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

      /*
       * The vendor's account of the call it made after being paid.
       *
       * Recorded with `attestedBy: "vendor"` stated in the outputs rather than
       * left to be inferred, and with **no** `StepAttestation` — the verifier
       * rejects a `vendor-upstream` step that carries one, because that would
       * be claiming a chain-verifiability no RPC can supply.
       *
       * Its timestamp is when the orchestrator *learned* this, not when the
       * upstream call happened: the information arrives inside the final 200
       * body, so it cannot be placed at its true moment in the sequence. The
       * vendor's own `latencyMs` is the only duration on offer, and it is the
       * vendor's number.
       *
       * `quotedAtomic` and `costAtomic` are both kept so a reader can see the
       * margin, and see when a call cost the vendor more than it charged.
       */
      case "vendor-upstream":
        this.append(
          "vendor-upstream",
          { capability: event["capability"], tier: event["tier"] },
          {
            attestedBy: "vendor",
            requestId: event["requestId"],
            latencyMs: event["latencyMs"],
            quotedAtomic: event["quotedAtomic"],
            costAtomic: event["costAtomic"],
            // Absent for everything that is not a rental, and never the
            // credential itself. See `redactLease`.
            ...(event["lease"] === undefined
              ? {}
              : { lease: redactLease(event["lease"]) }),
          },
        );
        break;

      case "failed":
        this.append("failed", null, { reason: event["reason"] });
        break;

      default:
        break;
    }
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

/**
 * Hex strings off an untyped event.
 *
 * Defensive because `IncomingEvent` is declared structurally — the trace package
 * deliberately does not import the orchestrator's types, so nothing but this
 * function stands between a malformed event and a step hash committing to
 * whatever was in it.
 */
function hexArray(value: unknown): readonly Hex[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Hex => typeof v === "string" && v.startsWith("0x"));
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

/**
 * The part of a lease that may be written down.
 *
 * Plan §5.3. A trace is a run record meant to be handed to an auditor, and a
 * lease turns the vendor's 200 into a credential that stays valuable after the
 * response. A trace carrying a live one is a trace nobody can hand to anyone.
 *
 * What is kept is the SHA-256 of the credential and its expiry, which is enough
 * to prove later which credential was issued for which payment — the only thing
 * this step was ever evidencing. The hash is computed here rather than trusted
 * from the caller, so a vendor that forgot to hash, or an orchestrator that
 * passed the wrong thing along, still cannot get a secret into the file.
 *
 * ## An allowlist, applied a second time
 *
 * `services/vendor-gpu` already reduces a lease to this shape before it leaves
 * the vendor. Doing it again here is not redundancy: the orchestrator sits
 * between the two and is the component this architecture assumes is
 * compromised, so the trace builder cannot take its word for what a lease
 * contains. An allowlist and not a scrub, because the two fail in opposite
 * directions: a scrub that misses a field name leaks, and an allowlist that
 * misses one merely omits.
 */
export function redactLease(raw: unknown): Record<string, unknown> {
  const lease = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  /*
   * Hashed here when the raw secret is present, which it should not be, and
   * preferred over any hash the caller supplied. A caller that sends both a
   * credential and a `credentialSha256` that do not match is either confused or
   * lying, and the hash of what was actually issued is the useful one.
   */
  const credential = lease["credential"];
  const hashed =
    typeof credential === "string" && credential !== ""
      ? sha256(toHex(credential))
      : typeof lease["credentialSha256"] === "string"
        ? (lease["credentialSha256"] as string)
        : undefined;

  const expiresAt = typeof lease["expiresAt"] === "number" ? lease["expiresAt"] : undefined;
  const blocks = typeof lease["blocks"] === "number" ? lease["blocks"] : undefined;
  const leaseId = typeof lease["id"] === "string" ? lease["id"] : lease["leaseId"];

  return {
    ...(typeof leaseId === "string" ? { leaseId } : {}),
    ...(hashed === undefined ? {} : { credentialSha256: hashed }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(blocks === undefined ? {} : { blocks }),
    // Said out loud, so a reader of the trace knows the omission is a rule and
    // not an oversight.
    credential: "[redacted]",
  };
}
