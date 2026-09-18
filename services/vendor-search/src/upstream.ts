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
 * The spend ceiling, defined once in `@ntux402/shared/node`.
 *
 * Re-exported rather than reimplemented, for the reason `query.ts` gives about
 * the query limit: `services/vendor-gpu` needs the same ledger against a very
 * different cap, and a spend control that exists twice is a spend control that
 * will eventually disagree with itself. The name stays importable from here
 * because the ceiling belongs to this service's boundary even though the code
 * enforcing it no longer lives in this file.
 */
export { SpendLedger } from "@ntux402/shared/node";
