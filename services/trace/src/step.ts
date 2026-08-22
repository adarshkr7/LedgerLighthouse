/**
 * The trace step and its hash chain (ARCHITECTURE.md §8.1):
 *
 *     step_hash = H(prior_hash || step_type || H(inputs) || H(outputs) || timestamp || H(attestation))
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
  /**
   * What the vendor says it did upstream once it was paid — the capability, the
   * tier, its own reported cost, and the upstream request id.
   *
   * **Vendor-attested, not chain-verified**, and the distinction is the whole
   * reason this type exists separately. Every other claim in a trace is either
   * re-derivable offline (the hash chain) or re-checkable against Base Sepolia
   * (the attested steps). This one is a third party's account of an HTTP call
   * to a service the verifier cannot reach, and no RPC will ever confirm it.
   *
   * The chain still protects it from *editing* — it hashes into the chain like
   * any other step, so it cannot be altered after the fact. What it does not
   * get is a `StepAttestation`, ever; `VENDOR_ATTESTED_STEPS` and the check in
   * `verify.ts` enforce that, because a step carrying one would be claiming a
   * verifiability it does not have.
   */
  | "vendor-upstream"
  | "failed";

/**
 * Step types whose content rests on a third party's word.
 *
 * Consulted by the verifier, which refuses to let any of them carry a
 * `StepAttestation`. Kept as data rather than a comment so adding a type forces
 * a decision about which side of that line it falls on.
 */
export const VENDOR_ATTESTED_STEPS: readonly StepType[] = ["vendor-upstream"];

/**
 * The three fields that make a payment step independently verifiable by someone
 * holding nothing but the trace and a public RPC (ARCHITECTURE.md §8.1).
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
