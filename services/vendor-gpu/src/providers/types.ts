/**
 * What the handler needs from a supply source, and nothing more.
 *
 * Narrow on purpose. `docs/GPU_RENTAL_PLAN.md` §3 recommends reselling one
 * provider behind an adapter, and the value of the adapter is entirely in how
 * little it exposes: the handler quotes from a SKU table, calls `runJob`, and
 * is never told whether the card came from RunPod, a decentralised market or a
 * machine under somebody's desk.
 *
 * The interface is also where the phase boundary sits. Phase 1 buys one bounded
 * job and gets a result back, so `runJob` is the whole surface. Phase 2 adds a
 * lease — provision, hand back a credential, renew, revoke — and that is a
 * second method here, not a different shape of the same one.
 *
 * ## Costs and failures
 *
 * `reportedCostAtomic` is what the provider says the run cost, in USDC atomic
 * units, which are also micros USD. Optional because not every provider reports
 * per-job cost, and the ledger charges the quoted price when it goes unreported
 * rather than treating an unknown as zero.
 *
 * A failure carries a status the way an HTTP upstream would, because that is
 * what the handler turns into a 502, and `0` means the request never completed.
 * A provider that fails has cost us provisioning time and possibly real money;
 * see the ordering argument in `handler.ts` for what happens to the payment.
 */

import type { GpuBlockMinutes, GpuSku, GpuWorkload } from "@ntux402/shared";

export interface JobRequest {
  readonly sku: GpuSku;
  /** How long the job may run. The vendor kills it at the boundary. */
  readonly minutes: GpuBlockMinutes;
  readonly workload: GpuWorkload;
  /**
   * The buyer's EIP-3009 authorization nonce, passed through as an idempotency
   * key for providers that accept one.
   *
   * Plan §5.2 keys the phase 2 lease store on exactly this value, because the
   * vault derives it as `keccak256(abi.encode(goalId, seq))` and it is
   * therefore stable across a byte-identical retry. Phase 1 holds no state, so
   * nothing here deduplicates on it yet — what stops a retry provisioning twice
   * today is the facilitator's `/verify`, which declines an authorization whose
   * nonce has already been consumed. That is a check, not a lock, and the
   * difference is why §5.2 is still a phase 2 item.
   */
  readonly idempotencyKey: string;
}

export type JobResult =
  | {
      readonly ok: true;
      /** The provider's own identifier for the run, for reconciliation. */
      readonly jobId: string;
      /** Which adapter served it. Ends up in the response and the trace. */
      readonly provider: string;
      /**
       * True when no real hardware ran. Reported rather than hidden, for the
       * reason `stubSettlement` marks itself: a demo that looks like the real
       * thing is worse than one that says what it is.
       */
      readonly simulated: boolean;
      /** Time from accepting the job to the card being ready, in ms. */
      readonly provisionMs: number;
      /** Time the workload actually ran, in ms. */
      readonly runMs: number;
      /** Whatever the workload measured. Opaque here; the buyer reads it. */
      readonly metrics: unknown;
      /** Provider-reported cost in USDC atomic units, when it reports one. */
      readonly reportedCostAtomic: string | undefined;
    }
  | {
      readonly ok: false;
      /** Provider status, or 0 when the request never completed. */
      readonly status: number;
      readonly error: string;
      /**
       * Whether a machine was allocated before the failure.
       *
       * The handler cannot settle a failed job, so this is the difference
       * between a refusal that cost nothing and one that has already started a
       * meter. It belongs in the log either way.
       */
      readonly provisioned: boolean;
    };

/** One supply source. See the header for why this is all of it. */
export interface GpuProvider {
  /** Human-readable name of the adapter, for logs and the response body. */
  readonly name: string;
  runJob(request: JobRequest): Promise<JobResult>;
}
