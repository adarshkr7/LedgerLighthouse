/**
 * What a live vendor sends back, and how to handle it without trusting it.
 *
 * Every string in a search result is written by a third party: the search
 * engine that scraped it, relayed by a vendor this project assumes is hostile.
 * The console renders it, so the console needs a place to put the rules — and
 * that place is here rather than in the component, because a `javascript:` URL
 * filter is a security control and the web app has no test runner to prove one
 * works.
 */

export interface SearchResultItem {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
  readonly score?: number;
}

/** The 200 body `services/vendor-aisa` returns once a payment has settled. */
export interface SearchPayload {
  readonly capability?: string;
  readonly tier?: string;
  readonly query?: string;
  readonly data?: {
    readonly answer?: string | null;
    readonly results?: readonly SearchResultItem[];
    readonly usage?: Record<string, unknown>;
    readonly request_id?: string;
  };
  readonly upstream?: {
    readonly requestId?: string;
    readonly latencyMs?: number;
    /** What the vendor actually paid, in USDC atomic units. Absent if unreported. */
    readonly costAtomic?: string;
    readonly quotedAtomic?: string;
  };
}

/**
 * An href safe to put in the console, or nothing.
 *
 * Only `http:` and `https:` survive. `javascript:` is the reason this exists —
 * a result title linked to one would be a single click from running script in
 * the console's own origin, next to a connected wallet — and `data:` and
 * `blob:` are refused for the same family of reason.
 *
 * A relative or unparseable href is dropped rather than guessed at. Resolving
 * it against the console's own origin is exactly the wrong repair: it would
 * turn a vendor's malformed link into a link to *us*.
 */
export function safeHref(raw: string | undefined): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
}

/** Host of an already-safe href, for a compact provenance line. */
export function hostOf(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

/** What a vendor reports about the upstream call it made on the buyer's behalf. */
export interface VendorUpstream {
  readonly requestId?: string;
  readonly latencyMs?: number;
  readonly costAtomic?: string;
  readonly quotedAtomic?: string;
}

/**
 * Pulls the vendor's account of its upstream call out of a paid payload.
 *
 * Every field is optional and none is trusted: this is a third party
 * describing an HTTP request the buyer cannot observe. It is recorded in the
 * trace as evidence of *what the vendor claimed*, never as a verified fact —
 * see the `vendor-upstream` step type.
 *
 * Returns nothing for the mock vendor's body, which carries no such block.
 */
export function vendorUpstreamOf(data: unknown): VendorUpstream | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const upstream = (data as { upstream?: unknown }).upstream;
  if (typeof upstream !== "object" || upstream === null) return undefined;

  const raw = upstream as Record<string, unknown>;
  const str = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
  const num = (key: string) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : undefined;

  const result: VendorUpstream = {
    ...(str("requestId") === undefined ? {} : { requestId: str("requestId") as string }),
    ...(num("latencyMs") === undefined ? {} : { latencyMs: num("latencyMs") as number }),
    // Amounts stay strings: they are atomic units and must never round-trip
    // through a float on their way into a hash.
    ...(/^[0-9]+$/.test(str("costAtomic") ?? "") ? { costAtomic: str("costAtomic") as string } : {}),
    ...(/^[0-9]+$/.test(str("quotedAtomic") ?? "")
      ? { quotedAtomic: str("quotedAtomic") as string }
      : {}),
  };

  return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * Narrows an opaque `paid` payload to something renderable, or nothing.
 *
 * Deliberately structural: the mock vendor's 200 body is a different shape
 * entirely, and this is what keeps the results panel from trying to render a
 * fabricated ETH/USD tick as a list of links.
 */
export function asSearchPayload(data: unknown): SearchPayload | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const payload = data as SearchPayload;
  const results = payload.data?.results;
  const answer = payload.data?.answer;
  if (!Array.isArray(results) && typeof answer !== "string") return undefined;
  return payload;
}
