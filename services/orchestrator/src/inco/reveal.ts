/**
 * Retrieving the confidential decision.
 *
 * The API is settled: `zap.attestedReveal([handle])` returns the plaintext plus
 * covalidator signatures, and needs **no wallet signature**, because `e.reveal`
 * already made the handle public. That is what lets the payment loop run
 * unattended (PRIMER.md §7.6).
 *
 * What is open is the *timing*. The commit transaction emits events; Inco's
 * compute server processes them afterwards. So this is a **bounded poll whose
 * timeout is a reported outcome, not an exception to swallow** — the guardrail
 * in IMPLEMENTATION.md §8 against replacing the wait with a hardcoded sleep.
 *
 * Nothing here touches a budget handle. The orchestrator asks for an attestation
 * over the *decision* handle, which is public and which it cannot forge — that
 * is expected and harmless (IMPLEMENTATION.md §1, invariant 1).
 */

import { bytesToHex, type Hex } from "viem";

export interface AttestedDecision {
  readonly approved: boolean;
  /** Covalidator signatures, hex-encoded for `bytes[]` calldata. */
  readonly signatures: readonly Hex[];
}

/** The one capability the payment loop needs from Inco. Faked in tests. */
export interface DecisionReader {
  /** Resolves undefined while the compute server has not produced it yet. */
  read(handle: Hex): Promise<AttestedDecision | undefined>;
}

export interface PollOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly onAttempt?: (attempt: number, elapsedMs: number, note?: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export type PollOutcome =
  | {
      readonly kind: "decided";
      readonly decision: AttestedDecision;
      readonly attempts: number;
      readonly latencyMs: number;
    }
  | {
      readonly kind: "timeout";
      readonly attempts: number;
      readonly elapsedMs: number;
      readonly lastError: string | undefined;
    };

export const DEFAULT_REVEAL_TIMEOUT_MS = 180_000;
export const DEFAULT_REVEAL_INTERVAL_MS = 1_000;

/**
 * Polls until the decision is retrievable or the budget runs out.
 *
 * A timeout is a returned outcome rather than a throw, because it is a real
 * state of the system and the caller must handle it: the debit has already
 * committed, so "decision unobtainable" is a distinct condition from "rejected"
 * and confusing the two would silently retry a spend the budget already paid
 * for (ARCHITECTURE.md §7.7, the [INCO] liveness row).
 */
export async function pollForDecision(
  reader: DecisionReader,
  handle: Hex,
  options: PollOptions = {},
): Promise<PollOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REVEAL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_REVEAL_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  const started = now();
  const deadline = started + timeoutMs;
  let attempts = 0;
  let lastError: string | undefined;

  while (now() < deadline) {
    attempts++;
    try {
      const decision = await reader.read(handle);
      if (decision) {
        return { kind: "decided", decision, attempts, latencyMs: now() - started };
      }
      lastError = "not ready";
    } catch (e) {
      // "Not ready yet" and "genuinely broken" are indistinguishable from here,
      // so both retry. The distinction shows up as a timeout with the last
      // error attached, which is enough to diagnose from.
      lastError = e instanceof Error ? e.message : String(e);
    }
    options.onAttempt?.(attempts, now() - started, lastError);
    await sleep(intervalMs);
  }

  return { kind: "timeout", attempts, elapsedMs: now() - started, lastError };
}

/** The shape we need from `@inco/lightning-js`, so the SDK stays injectable. */
export interface LightningZap {
  attestedReveal(handles: readonly Hex[]): Promise<
    ReadonlyArray<{
      plaintext: { value: unknown };
      covalidatorSignatures: readonly Uint8Array[];
    }>
  >;
}

export class IncoDecisionReader implements DecisionReader {
  readonly #zap: LightningZap;

  constructor(zap: LightningZap) {
    this.#zap = zap;
  }

  async read(handle: Hex): Promise<AttestedDecision | undefined> {
    const results = await this.#zap.attestedReveal([handle]);
    const first = results[0];
    if (!first) return undefined;
    return {
      // An `ebool` comes back as 0/1 or false/true depending on the path; both
      // mean the same thing and `Boolean` is the honest coercion here.
      approved: Boolean(first.plaintext.value),
      // The SDK hands back Uint8Array; viem needs `0x…` to encode `bytes[]`.
      signatures: first.covalidatorSignatures.map((sig) => bytesToHex(sig)),
    };
  }
}
