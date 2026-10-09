/**
 * Whether Inco can reveal a decision right now.
 *
 * A run cannot finish without an attested reveal, and a reveal needs every
 * covalidator in Inco's signing threshold. On Base Sepolia that threshold is
 * two of two (read from the SDK on 27 September 2026), so one covalidator
 * down is enough to stop every decision. When that happens a run commits its
 * spend and then waits for a decision that cannot arrive, which on screen is
 * "Confidential evaluation" spinning until the reveal timeout.
 *
 * The probe asks for a decision that is already known: the approved spend in
 * the recorded run under docs/runs (goal 47, seq 1). That handle was revealed
 * on chain long ago, so the only things that can make this fail are Inco's
 * covalidators and the RPC they read from. It costs no gas and signs nothing.
 *
 * It exists so the orchestrator can refuse a run *before* `requestSpend`.
 * Refusing then costs nothing; discovering it after the commit leaves a
 * pending spend and a spinner.
 */

import type { Hex } from "viem";
import { NETWORKS } from "@ntux402/shared";

import type { DecisionReader } from "./reveal.js";

/**
 * Decision handle of goal 47, seq 1 on the Base Sepolia PolicyVault: approved,
 * finalized. Other networks carry their own in `NETWORKS`, or none yet.
 */
export const INCO_PROBE_HANDLE: Hex = NETWORKS["base-sepolia"].incoProbeHandle!;

export type IncoHealth =
  | { readonly status: "ready"; readonly latencyMs: number; readonly checkedAt: number }
  | { readonly status: "unavailable"; readonly detail: string; readonly checkedAt: number };

export interface IncoHealthOptions {
  /** A handle that is already revealed on chain. Defaults to `INCO_PROBE_HANDLE`. */
  readonly handle?: Hex | undefined;
  /**
   * How long one probe may take. The SDK retries 503s internally, so a dead
   * covalidator shows up as a slow call rather than a fast failure.
   */
  readonly timeoutMs?: number;
  /** How long an answer is reused. Keeps a busy console from hammering Inco. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class IncoHealthProbe {
  readonly #reader: DecisionReader;
  readonly #handle: Hex;
  readonly #timeoutMs: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #last: IncoHealth | undefined;
  #inFlight: Promise<IncoHealth> | undefined;

  constructor(reader: DecisionReader, options: IncoHealthOptions = {}) {
    this.#reader = reader;
    this.#handle = options.handle ?? INCO_PROBE_HANDLE;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  /** The cached answer while it is fresh, otherwise a new probe. Callers share one probe. */
  check(): Promise<IncoHealth> {
    if (this.#last && this.#now() - this.#last.checkedAt < this.#ttlMs) {
      return Promise.resolve(this.#last);
    }
    this.#inFlight ??= this.#probe().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #probe(): Promise<IncoHealth> {
    const started = this.#now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#timeoutMs);
    });

    let result: IncoHealth;
    try {
      const outcome = await Promise.race([this.#reader.read(this.#handle), timeout]);
      if (outcome === "timeout") {
        result = {
          status: "unavailable",
          detail: `no answer from Inco within ${Math.round(this.#timeoutMs / 1000)}s`,
          checkedAt: this.#now(),
        };
      } else if (outcome === undefined || outcome.signatures.length === 0) {
        result = {
          status: "unavailable",
          detail: "Inco answered without a signed decision",
          checkedAt: this.#now(),
        };
      } else {
        result = { status: "ready", latencyMs: this.#now() - started, checkedAt: this.#now() };
      }
    } catch (e) {
      result = {
        status: "unavailable",
        detail: e instanceof Error ? e.message : String(e),
        checkedAt: this.#now(),
      };
    } finally {
      clearTimeout(timer);
    }

    this.#last = result;
    return result;
  }
}
