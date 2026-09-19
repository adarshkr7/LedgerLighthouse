/**
 * Renewing a lease under a budget the renewing process cannot read.
 *
 * Plan §5.5, and the demonstration this architecture has been building toward.
 * Every run until now was one decision: buy this or do not. A lease turns that
 * into a sequence — buy, and then keep deciding whether to keep it — against a
 * running total nobody in this process can see. The run ends when the budget
 * says so, and the component that gets told is the one with no authority to
 * argue.
 *
 * ## Why a renewal cannot simply be issued when it is due
 *
 * `PolicyVault.requestSpend` reverts with `SpendPending` while a spend is
 * outstanding on the same goal: `pendingSeq` is set by `requestSpend` and
 * cleared only by `finalizeDecision`. Spends on one goal are therefore strictly
 * sequential, and a renewal that fires on a timer will meet that rule sooner or
 * later.
 *
 * So the runner waits for the goal to be clear before it starts, and it waits
 * with a deadline, because waiting past the block boundary is not waiting any
 * more — it is a machine being switched off while this process is still
 * politely queueing.
 *
 * ## The lead time is the vendor's to state
 *
 * `renewBy` comes back in the 200. It is expiry minus a lead the vendor sets,
 * which §5.5 derives from the measured decision cycle: 6.6s to 13.8s across the
 * twelve traces on record, plus provisioning, plus margin. This runner does not
 * recompute it. A deadline invented on the buyer's side would drift from the
 * one the seller enforces, and the seller is the one holding the machine.
 *
 * ## Two ways to lose a lease, reported differently
 *
 * §5.5 asks for exactly this distinction, and it is the reason the outcome type
 * below is not a boolean.
 *
 * A renewal the *policy* refuses is the system working. The budget ran out, the
 * encrypted balance said no, and the buyer needs that news before the machine
 * dies rather than after — which is what the lead time buys. `refused` carries
 * the chain evidence so a viewer can check the bounce came from Inco.
 *
 * A renewal still pending at the boundary is the same loss for a worse reason:
 * a slow chain, a stuck decision, a goal busy with somebody else's spend.
 * `abandoned` says so, and an operator reading a trace can tell the two apart
 * without guessing.
 */

import {
  leaseSummaryOf,
  untilRenewMs,
  type LeaseSummary,
} from "@ntux402/shared";

import type { PaymentEvent, PaymentLoop, PaymentResult } from "./payment-loop.js";

/** Just enough of the relay to ask whether the goal is busy. */
export interface PendingReader {
  pendingSeq(goalId: bigint): Promise<bigint>;
}

export type LeaseEvent =
  | { readonly type: "lease-opened"; readonly lease: LeaseSummary }
  /** The lead time has elapsed and a renewal is about to be attempted. */
  | { readonly type: "renewal-due"; readonly lease: LeaseSummary; readonly remainingMs: number }
  /** The goal has a spend outstanding. Waiting, with the boundary as a deadline. */
  | { readonly type: "renewal-waiting"; readonly lease: LeaseSummary; readonly pendingSeq: string }
  | { readonly type: "renewed"; readonly lease: LeaseSummary }
  /**
   * The policy said no. The lease ends at its own boundary and nothing else
   * happens; this is the system working, said out loud while there is still
   * time on the block.
   */
  | {
      readonly type: "renewal-refused";
      readonly lease: LeaseSummary;
      readonly goalId: string;
      readonly seq: string;
      readonly decisionHandle: `0x${string}`;
      readonly commitTx: `0x${string}`;
      readonly remainingMs: number;
    }
  /** Lost to a slow chain rather than to the policy. See the header. */
  | {
      readonly type: "renewal-abandoned";
      readonly lease: LeaseSummary;
      readonly reason: "chain-busy" | "decision-unavailable" | "vendor-failed";
      readonly detail: string;
    }
  | {
      readonly type: "lease-ended";
      readonly lease: LeaseSummary;
      readonly blocks: number;
      readonly reason: "refused" | "abandoned" | "block-limit";
    };

export interface LeaseRunnerConfig {
  readonly loop: PaymentLoop;
  readonly pending: PendingReader;
  /**
   * Builds the URL for one purchase. `undefined` opens a lease; a lease id
   * renews that one.
   *
   * A function rather than a base string, because the URL is what the vault
   * freezes into `termsHash` and it has to be derived the same way every time.
   * The server passes `resourceUrlFor`, so the renewal and the first purchase
   * come out of the same builder.
   */
  readonly urlFor: (renewOf: string | undefined) => string;
  /**
   * How many blocks a single run may buy, first one included.
   *
   * A stop that is not the budget's. Without it a demo left open renews until
   * the goal is empty, which is a long wait and a real bill. The budget is
   * still the interesting limit; this one keeps an unattended tab bounded.
   */
  readonly maxBlocks?: number;
  /** How often to re-check a busy goal. */
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onEvent?: (event: LeaseEvent) => void;
  /** Forwarded to the payment loop, so a run's own events still stream. */
  readonly onPaymentEvent?: (event: PaymentEvent) => void;
  /**
   * Minutes one block buys, for the question the agent is asked on a renewal.
   *
   * Comes from the catalog entry the URL was built from. The runner does not
   * parse it back out of the URL: that string is what the vault hashes, and
   * reading it for a second purpose is how two readings of one string end up
   * disagreeing.
   */
  readonly blockMinutes?: number;
}

export interface LeaseRunOutcome {
  readonly lease: LeaseSummary | undefined;
  readonly blocks: number;
  readonly ended: "refused" | "abandoned" | "block-limit" | "not-a-lease" | "failed";
  readonly detail?: string;
}

const DEFAULT_MAX_BLOCKS = 4;
const DEFAULT_POLL_MS = 2_000;

export class LeaseRunner {
  readonly #config: LeaseRunnerConfig;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(config: LeaseRunnerConfig) {
    this.#config = config;
    this.#now = config.now ?? Date.now;
    this.#sleep = config.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  #emit(event: LeaseEvent): void {
    this.#config.onEvent?.(event);
  }

  /**
   * Buys a lease and keeps it alive until something stops it.
   *
   * Returns rather than throws for every ending it anticipates. A refused
   * renewal is not an error — it is the outcome the whole system exists to
   * produce — and a caller that had to catch it would be catching the demo.
   */
  async run(goalId: bigint): Promise<LeaseRunOutcome> {
    const maxBlocks = this.#config.maxBlocks ?? DEFAULT_MAX_BLOCKS;

    const first = await this.#config.loop.fetchPaid(this.#config.urlFor(undefined), goalId, {
      ...(this.#config.onPaymentEvent ? { onEvent: this.#config.onPaymentEvent } : {}),
      fresh: true,
    });

    if (first.kind !== "paid") {
      return { blocks: 0, lease: undefined, ended: "failed", detail: describe(first) };
    }

    let lease = leaseSummaryOf(first.data);
    if (lease === undefined) {
      /*
       * Paid for, and not a lease. The one-shot job route answers this shape,
       * so a caller that pointed the runner at it has bought exactly what it
       * asked for and there is nothing to renew. Reported rather than retried.
       */
      return { blocks: 1, lease: undefined, ended: "not-a-lease" };
    }

    this.#emit({ type: "lease-opened", lease });

    let blocks = 1;
    while (blocks < maxBlocks) {
      // --- wait out the block, less the vendor's lead time ------------------
      await this.#sleep(untilRenewMs(lease, this.#now()));
      this.#emit({
        type: "renewal-due",
        lease,
        remainingMs: Math.max(0, lease.expiresAt - this.#now()),
      });

      // --- the goal has to be clear before requestSpend will take it --------
      const clear = await this.#waitForClearGoal(goalId, lease);
      if (!clear) {
        const detail =
          "the goal still had a spend pending when the block ran out; the lease was " +
          "not renewed and the machine has been reclaimed";
        this.#emit({ type: "renewal-abandoned", lease, reason: "chain-busy", detail });
        this.#emit({ type: "lease-ended", lease, blocks, reason: "abandoned" });
        return { lease, blocks, ended: "abandoned", detail };
      }

      // --- the renewal purchase, at seq + 1 on the same goal ----------------
      const result = await this.#config.loop.fetchPaid(this.#config.urlFor(lease.id), goalId, {
        ...(this.#config.onPaymentEvent ? { onEvent: this.#config.onPaymentEvent } : {}),
        fresh: true,
        /*
         * A renewal's terms are byte-identical to the block before it, so an
         * agent told nothing would be answering "is this worth buying" about a
         * machine it has already bought. The question is whether to keep it.
         */
        context: {
          kind: "renewal",
          blocks: lease.blocks,
          minutes: this.#config.blockMinutes ?? 0,
        },
      });

      if (result.kind === "paid") {
        const renewed = leaseSummaryOf(result.data);
        if (renewed === undefined) {
          const detail = "the vendor's renewal response carried no lease";
          this.#emit({ type: "renewal-abandoned", lease, reason: "vendor-failed", detail });
          this.#emit({ type: "lease-ended", lease, blocks, reason: "abandoned" });
          return { lease, blocks, ended: "abandoned", detail };
        }
        lease = renewed;
        blocks += 1;
        this.#emit({ type: "renewed", lease });
        continue;
      }

      if (result.kind === "policy-rejected") {
        /*
         * The point of the lead time, arriving on schedule. There is still
         * block left, the machine is still up, and the buyer is being told now
         * rather than discovering it when the endpoint stops answering.
         */
        this.#emit({
          type: "renewal-refused",
          lease,
          goalId: result.goalId.toString(),
          seq: result.seq.toString(),
          decisionHandle: result.decisionHandle,
          commitTx: result.commitTx,
          remainingMs: Math.max(0, lease.expiresAt - this.#now()),
        });
        this.#emit({ type: "lease-ended", lease, blocks, reason: "refused" });
        return { lease, blocks, ended: "refused" };
      }

      const reason = result.kind === "decision-unavailable" ? "decision-unavailable" : "vendor-failed";
      const detail = describe(result);
      this.#emit({ type: "renewal-abandoned", lease, reason, detail });
      this.#emit({ type: "lease-ended", lease, blocks, reason: "abandoned" });
      return { lease, blocks, ended: "abandoned", detail };
    }

    this.#emit({ type: "lease-ended", lease, blocks, reason: "block-limit" });
    return { lease, blocks, ended: "block-limit" };
  }

  /**
   * Waits until no spend is outstanding on the goal, or the block runs out.
   *
   * The deadline is the lease's own expiry and not a fixed timeout, because
   * what is being waited for is worth exactly as much as the time left on the
   * machine. Once the block is gone the renewal has nothing to extend, and
   * `LeaseStore.renew` refuses an expired lease for the same reason.
   */
  async #waitForClearGoal(goalId: bigint, lease: LeaseSummary): Promise<boolean> {
    const pollMs = this.#config.pollMs ?? DEFAULT_POLL_MS;
    let announced = false;

    for (;;) {
      const pending = await this.#config.pending.pendingSeq(goalId);
      if (pending === 0n) return true;

      if (this.#now() >= lease.expiresAt) return false;

      // Said once. A line per poll would bury the fact it is reporting.
      if (!announced) {
        announced = true;
        this.#emit({ type: "renewal-waiting", lease, pendingSeq: pending.toString() });
      }

      // Never sleep past the boundary: the next check has to happen while
      // there is still a lease to renew.
      const untilBoundary = Math.max(0, lease.expiresAt - this.#now());
      await this.#sleep(Math.min(pollMs, untilBoundary));
    }
  }
}

/** One line describing a result that is not a paid one. */
function describe(result: PaymentResult): string {
  switch (result.kind) {
    case "failed":
      return result.reason;
    case "decision-unavailable":
      return `the decision never resolved after ${result.attempts} attempts over ${Math.round(
        result.elapsedMs / 1000,
      )}s`;
    case "policy-rejected":
      return "the confidential policy refused the spend";
    default:
      return result.kind;
  }
}
