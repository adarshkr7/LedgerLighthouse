/**
 * The upstream search client, and the only place `SEARCH_VENDOR_KEY` is used.
 *
 * Tavily's search route is a POST. The x402 client that buys from us is
 * GET-only — `X402Client.fetchResource` hardcodes the method and keys its cache
 * on it. Rather than widen that client (a change to the payment path, for a
 * capability question), the shim takes a GET and issues the POST itself. GET
 * in, POST out; the payment loop never learns the difference.
 *
 * ## Cost
 *
 * Gateways that report per-call cost do it in a response header carrying micros
 * USD. Micros USD and USDC atomic units are both millionths, so the header
 * value is already an atomic amount and nothing here converts anything.
 *
 * *Which* header is provider-specific, so it is configuration
 * (`SEARCH_COST_HEADER`) rather than a constant. Unset means cost simply is not
 * reported, and the code below is written for that: the header is read
 * defensively and never required. Refusing to serve a call we have already paid
 * for, because a header we were never promised went missing, would trade the
 * product for a reconciliation figure.
 *
 * ## There is no default base URL
 *
 * `baseUrl` is required. A default would name one provider in a file whose
 * whole point is that it names none, and a stale default is worse than a
 * missing one: it fails at the first paid call rather than at boot.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type SearchTier } from "@ntux402/shared";

export interface UpstreamOptions {
  readonly apiKey: string;
  /** Gateway origin. Required — see the header. */
  readonly baseUrl: string;
  /**
   * Response header carrying this call's cost in micros USD, if the provider
   * sends one. Omitted means cost goes unreported and the quoted price stands
   * unreconciled.
   */
  readonly costHeader?: string | undefined;
  /** Injectable so tests never reach the network and never spend a cent. */
  readonly fetchImpl?: typeof fetch;
}

export type UpstreamResult =
  | {
      readonly ok: true;
      readonly body: unknown;
      /** Reported cost in USDC atomic units, when the provider said. */
      readonly costAtomic: string | undefined;
      /** The header the figure above was read from, when one is configured. */
      readonly costHeader?: string | undefined;
      readonly requestId: string | undefined;
      readonly latencyMs: number;
    }
  | {
      readonly ok: false;
      /** Upstream status, or 0 when the request never completed. */
      readonly status: number;
      readonly error: string;
    };

/** What the handler needs from an upstream. Narrow, so tests can stand in for it. */
export interface UpstreamSearch {
  search(query: string, tier: SearchTier): Promise<UpstreamResult>;
}

export class GatewaySearch implements UpstreamSearch {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #costHeader: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: UpstreamOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#costHeader = options.costHeader;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async search(query: string, tier: SearchTier): Promise<UpstreamResult> {
    const started = Date.now();

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/apis/v1/tavily/search`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query,
          // Depth and result count come from the tier, never from the caller.
          // A request that could dial `search_depth` could dial our cost.
          search_depth: tier.searchDepth,
          max_results: tier.maxResults,
          include_usage: true,
        }),
      });
    } catch (e) {
      return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: text.replace(/\s+/g, " ").slice(0, 200),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (e) {
      return {
        ok: false,
        status: response.status,
        error: `upstream returned non-JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const rawCost =
      this.#costHeader === undefined ? null : response.headers.get(this.#costHeader);
    const costAtomic = rawCost !== null && /^[0-9]+$/.test(rawCost.trim())
      ? rawCost.trim()
      : undefined;

    const requestId =
      typeof (body as { request_id?: unknown } | null)?.request_id === "string"
        ? (body as { request_id: string }).request_id
        : undefined;

    return {
      ok: true,
      body,
      costAtomic,
      ...(this.#costHeader === undefined ? {} : { costHeader: this.#costHeader }),
      requestId,
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * A spend ceiling denominated in money rather than in calls.
 *
 * Six candidate balance endpoints were probed and all six 404'd, so there is no
 * account balance to poll and no way to ask the provider to stop. What there is, is the
 * per-call cost header — which makes a local running total the only spend
 * control that exists, and lets it be expressed in dollars instead of in a
 * proxy for them.
 *
 * A call whose cost went unreported still counts, at the tier's quoted price.
 * Treating an unknown cost as zero would make the missing header the cheapest
 * way past the ceiling.
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
