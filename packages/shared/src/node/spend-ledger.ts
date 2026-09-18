import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A spend ceiling denominated in money rather than in calls.
 *
 * Lives here rather than in a vendor because two resource servers now need one
 * and a security control with two implementations has one that is wrong. The
 * search vendor and the GPU vendor set very different caps against very
 * different upstreams; what they share is the arithmetic and the persistence,
 * which is exactly what drifts when it is copied.
 *
 * The search provider was probed for a balance endpoint and six candidates all
 * 404'd, so there is no account balance to poll and no way to ask upstream to
 * stop. What there is, is a per-call cost figure, which makes a local running
 * total the only spend control that exists and lets it be expressed in dollars
 * instead of in a proxy for them. A GPU provider with a real balance API would
 * be a better backstop and still not a substitute: the balance is shared with
 * every other thing the key pays for, and this ceiling is per service.
 *
 * A call whose cost went unreported still counts, at the quoted price. Treating
 * an unknown cost as zero would make a missing figure the cheapest way past the
 * ceiling.
 *
 * ## Why it is written to disk
 *
 * It used to live only in memory, and that made restarting the cheapest way
 * past the ceiling — worse than the missing header, because a service that
 * crashes and restarts under load does it by itself. A crash loop with an
 * in-memory ledger is unbounded spend against a real balance, arrived at
 * without anybody doing anything wrong.
 *
 * The file holds two numbers and no secret. Its absence, corruption, or
 * unreadability all resolve to *start a fresh window* rather than to a refusal:
 * a ledger that cannot be read is a reason to be careful, not a reason to stop
 * selling, and the per-key spending cap at the provider is the backstop that
 * does not depend on this process at all.
 */
export class SpendLedger {
  readonly #capAtomic: bigint;
  readonly #windowMs: number;
  #spentAtomic = 0n;
  #windowStart: number;
  readonly #now: () => number;
  readonly #path: string | undefined;

  constructor(options: {
    capAtomic: string;
    windowMs?: number;
    now?: () => number;
    /** Where to persist. Omitted keeps the ledger in memory — tests, mostly. */
    path?: string | undefined;
  }) {
    this.#capAtomic = BigInt(options.capAtomic);
    this.#windowMs = options.windowMs ?? 60 * 60 * 1000;
    this.#now = options.now ?? Date.now;
    this.#windowStart = this.#now();
    this.#path = options.path;
    this.#load();
  }

  #load(): void {
    if (this.#path === undefined || !existsSync(this.#path)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      if (typeof raw !== "object" || raw === null) return;
      const { spentAtomic, windowStart } = raw as Record<string, unknown>;
      if (typeof spentAtomic !== "string" || !/^[0-9]+$/.test(spentAtomic)) return;
      if (typeof windowStart !== "number" || !Number.isFinite(windowStart)) return;
      // A window that started in the future is a clock change, not a ledger —
      // and honouring it would suppress the ceiling until it caught up.
      if (windowStart > this.#now()) return;
      this.#spentAtomic = BigInt(spentAtomic);
      this.#windowStart = windowStart;
    } catch {
      /* unreadable ledger: start a fresh window rather than refuse to serve */
    }
  }

  #save(): void {
    if (this.#path === undefined) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(
        this.#path,
        JSON.stringify({ spentAtomic: this.#spentAtomic.toString(), windowStart: this.#windowStart }),
      );
    } catch {
      /* a ledger we cannot write is not a reason to fail a call already paid for */
    }
  }

  #roll(): void {
    const now = this.#now();
    if (now - this.#windowStart >= this.#windowMs) {
      this.#windowStart = now;
      this.#spentAtomic = 0n;
      this.#save();
    }
  }

  /** True when another call at this price would breach the ceiling. */
  wouldExceed(priceAtomic: string): boolean {
    this.#roll();
    return this.#spentAtomic + BigInt(priceAtomic) > this.#capAtomic;
  }

  record(costAtomic: string | undefined, fallbackAtomic: string): void {
    this.#roll();
    this.#spentAtomic += BigInt(costAtomic ?? fallbackAtomic);
    this.#save();
  }

  get spentAtomic(): string {
    this.#roll();
    return this.#spentAtomic.toString();
  }

  get capAtomic(): string {
    return this.#capAtomic.toString();
  }
}
