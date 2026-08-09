/**
 * The trace step and its hash chain (plan §8.1):
 *
 *     step_hash = H(prior_hash || step_type || H(inputs) || H(outputs) || timestamp)
 *
 * Each step commits to the one before it, so a trace cannot be reordered,
 * truncated from the front, or have a step edited without every later hash
 * changing. Bounced attempts stay in the chain — a policy that never fires is
 * indistinguishable from a policy that does not work, and the injection demo
 * depends on the bounce being visible.
 */

import { concatHex, keccak256, numberToHex, toHex, type Hex } from "viem";

import { hashPayload } from "./canonical.js";

export type StepType =
  | "request"
  | "payment-required"
  | "terms-rejected"
  | "agent-reasoning"
  | "spend-requested"
  | "decision-revealed"
  | "decision-finalized"
  | "signer-refused"
  | "authorization-signed"
  | "settled"
  | "response"
  | "failed";

/**
 * The three fields that make a payment step independently verifiable by someone
 * holding nothing but the trace and a public RPC (plan §8.1).
 */
export interface StepAttestation {
  /** The `ok` handle for this spend. */
  readonly decisionHandle: Hex;
  /** Verifiable through the Inco verifier, and re-checkable on chain. */
  readonly covalidatorSignatures: readonly Hex[];
  /** The `requestSpend` transaction. */
  readonly commitTx: Hex;
  readonly finalizeTx?: Hex;
  readonly goalId: string;
  readonly seq: string;
  readonly approved: boolean;
}

export interface TraceStep {
  readonly index: number;
  readonly type: StepType;
  /** Epoch milliseconds. Part of the hash, so it cannot be rewritten later. */
  readonly timestamp: number;
  readonly inputs: unknown;
  readonly outputs: unknown;
  readonly attestation?: StepAttestation;
  readonly priorHash: Hex;
  readonly hash: Hex;
}

/** The chain's anchor. Distinct from `bytes32(0)` so an empty trace is not a valid prefix. */
export const GENESIS_HASH: Hex = keccak256(toHex("ntux402/trace/v1"));

export function computeStepHash(step: Omit<TraceStep, "hash">): Hex {
  return keccak256(
    concatHex([
      step.priorHash,
      keccak256(toHex(step.type)),
      hashPayload(step.inputs ?? null),
      hashPayload(step.outputs ?? null),
      // Fixed-width, so no pair of (timestamp, next field) values can be
      // confused for a different pair through concatenation.
      numberToHex(step.timestamp, { size: 32 }),
      // Absent and present-but-empty must hash differently.
      step.attestation ? hashPayload(step.attestation) : keccak256(toHex("no-attestation")),
    ]),
  );
}

export interface Trace {
  readonly version: 1;
  readonly goalId: string;
  readonly vault: Hex;
  readonly chainId: number;
  readonly steps: readonly TraceStep[];
  /** Merkle root over the step hashes. 32 bytes, anchorable on chain. */
  readonly root: Hex;
}
