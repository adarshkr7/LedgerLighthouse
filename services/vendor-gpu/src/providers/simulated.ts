/**
 * A supply source with no hardware behind it.
 *
 * Plan §8 question 1 is open: no provider has been chosen, because provisioning
 * latency decides it and nobody has measured that. Writing a RunPod adapter now
 * would mean shipping a payment path proved against an account that does not
 * exist, so this adapter stands in until the question is answered. It occupies
 * the same seam a real one will, and everything around it — pricing, the spend
 * ceiling, the order of operations, the 402 — is exercised for real against it.
 *
 * ## What it does not pretend
 *
 * Every result it returns carries `simulated: true`, and the handler copies
 * that into the response body and therefore into the trace. A run record that
 * cannot be told apart from a real rental is a run record nobody should trust,
 * and the failure mode it guards against is mundane: a demo left running past
 * the point where somebody starts quoting its numbers.
 *
 * It also does not sit for fifteen minutes. A block's worth of wall clock is
 * the one thing about a rental nothing is learned from waiting through, so the
 * run is compressed by `timeScale` and the result reports the compressed figure
 * in `runMs` alongside the block length that was actually bought. Provisioning
 * is modelled rather than compressed, because §5.4 puts provisioning *inside*
 * the payment window and its size is the argument: the vendor carries a
 * provisioned machine from the moment it exists until settlement returns.
 *
 * The default 30 seconds is the bottom of the 30-to-120-second range §5.4
 * quotes, and it is a guess in the same way the SKU costs are a guess. Demos
 * set it to something small. The measurement that replaces it is what decides
 * the provider.
 */

import { GPU_WORKLOADS, type GpuWorkload } from "@ntux402/shared";

import type {
  GpuProvider,
  JobRequest,
  JobResult,
  LeaseProvisionResult,
  LeaseRequest,
} from "./types.js";

export interface SimulatedProviderOptions {
  /**
   * Modelled time from accepting a job to the card being ready, in ms.
   *
   * See the header: this is the window §5.4 is about, so it is modelled at a
   * plausible size instead of being skipped.
   */
  readonly provisionMs?: number;
  /**
   * How much of a block to actually wait through. `0` returns immediately;
   * `1` would run the full duration, which nothing wants.
   */
  readonly timeScale?: number;
  /** Injectable so tests neither wait nor depend on a real clock. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /**
   * Forces a failure, for exercising the paths that matter most. `provisioned`
   * says whether the failure happened after a machine was allocated, which is
   * the difference between a refusal that cost nothing and one that started a
   * meter.
   */
  readonly failWith?: { status: number; error: string; provisioned: boolean } | undefined;
  /**
   * Makes every termination fail, for exercising the reclaimer's refusal to
   * record a machine as given back when it is still running.
   */
  readonly terminateFails?: boolean;
}

const DEFAULT_PROVISION_MS = 30_000;

/** Deterministic pseudo-metrics, so two identical jobs report identically. */
function metricsFor(workload: GpuWorkload, sku: string, minutes: number): unknown {
  // A cheap stable hash of the request, so the numbers move with the inputs and
  // never move without them. Nothing here is a measurement and the shape is the
  // only part a real adapter will keep.
  let h = 2166136261;
  for (const ch of `${workload.name}:${sku}:${minutes}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  const spread = (lo: number, hi: number) => lo + ((h % 1000) / 1000) * (hi - lo);

  switch (workload.name) {
    case "gpu-burn":
      return {
        workload: workload.name,
        sustainedUtilisationPct: Number(spread(93, 99).toFixed(1)),
        peakMemoryGb: Number(spread(8, 22).toFixed(1)),
        thermalThrottleEvents: h % 3,
      };
    case "matmul-bench":
      return {
        workload: workload.name,
        tflops: { "4096": Number(spread(28, 44).toFixed(1)), "8192": Number(spread(31, 49).toFixed(1)) },
      };
    case "model-warmup":
      return {
        workload: workload.name,
        weightsLoadMs: Math.round(spread(4_000, 21_000)),
        timeToFirstTokenMs: Math.round(spread(180, 900)),
      };
  }
}

export class SimulatedGpuProvider implements GpuProvider {
  readonly name = "simulated";

  readonly #provisionMs: number;
  readonly #timeScale: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #failWith: SimulatedProviderOptions["failWith"];
  readonly #terminateFails: boolean;
  /** Handle -> hard expiry, so a test can see what was never given back. */
  readonly #running = new Map<string, number>();

  constructor(options: SimulatedProviderOptions = {}) {
    this.#provisionMs = options.provisionMs ?? DEFAULT_PROVISION_MS;
    this.#timeScale = options.timeScale ?? 0;
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#now = options.now ?? Date.now;
    this.#failWith = options.failWith;
    this.#terminateFails = options.terminateFails ?? false;
  }

  async runJob(request: JobRequest): Promise<JobResult> {
    const started = this.#now();

    if (this.#failWith && !this.#failWith.provisioned) {
      return { ok: false, ...this.#failWith };
    }

    await this.#sleep(this.#provisionMs);
    const provisionedAt = this.#now();

    if (this.#failWith) {
      return { ok: false, ...this.#failWith };
    }

    await this.#sleep(request.minutes * 60_000 * this.#timeScale);
    const finished = this.#now();

    return {
      ok: true,
      /*
       * Derived from the idempotency key, never random. Two identical requests
       * produce the same id, which is what makes a duplicate visible in a log
       * instead of looking like a second legitimate job, and it is the property
       * phase 2's nonce-keyed lease store will rely on.
       */
      jobId: `sim-${request.idempotencyKey.replace(/^0x/, "").slice(0, 16)}`,
      provider: this.name,
      simulated: true,
      provisionMs: provisionedAt - started,
      runMs: finished - provisionedAt,
      metrics: metricsFor(
        GPU_WORKLOADS[request.workload.name],
        request.sku.name,
        request.minutes,
      ),
      // No provider, no reported cost. The ledger charges the quoted price,
      // which is the same thing it does for a real provider that stays quiet.
      reportedCostAtomic: undefined,
    };
  }

  /**
   * Allocates a machine and leaves it running.
   *
   * The endpoint is an origin and carries no secret. A signed URL would be a
   * credential wearing a location's clothes, and plan §5.3 names exactly that
   * as the thing a trace must not end up holding — so the secret stays in the
   * credential field where `redactable()` can see it and drop it.
   *
   * `hardExpirySet` is true here because a stand-in can honour anything it is
   * told. A real adapter reports what the provider actually supports, and an
   * adapter that answers false is telling the operator they are the backstop.
   */
  async provisionLease(request: LeaseRequest): Promise<LeaseProvisionResult> {
    const started = this.#now();

    if (this.#failWith && !this.#failWith.provisioned) {
      return { ok: false, ...this.#failWith };
    }

    await this.#sleep(this.#provisionMs);

    if (this.#failWith) {
      return { ok: false, ...this.#failWith };
    }

    const handle = `sim-box-${request.idempotencyKey.replace(/^0x/, "").slice(0, 16)}`;
    this.#running.set(handle, request.hardExpiryAt);

    return {
      ok: true,
      providerHandle: handle,
      endpoint: `https://${handle}.gpu.invalid`,
      provider: this.name,
      simulated: true,
      provisionMs: this.#now() - started,
      hardExpirySet: true,
    };
  }

  /**
   * Gives a machine back, and says ok for one that was already gone.
   *
   * Idempotent because the reclaimer retries what it could not finish: a sweep
   * that failed on a network blip and succeeded on the next pass must not then
   * see a permanent error and keep the record alive forever.
   */
  async terminateLease(providerHandle: string): Promise<{ ok: boolean; error?: string }> {
    if (this.#terminateFails) {
      return { ok: false, error: "provider unreachable" };
    }
    this.#running.delete(providerHandle);
    return { ok: true };
  }

  /** Test-only view of what this adapter still believes is running. */
  get running(): readonly string[] {
    return [...this.#running.keys()];
  }
}
