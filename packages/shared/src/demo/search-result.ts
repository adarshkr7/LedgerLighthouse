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

/** The 200 body `services/vendor-search` returns once a payment has settled. */
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

/** What a vendor reports about the work it did on the buyer's behalf. */
export interface VendorUpstream {
  readonly requestId?: string;
  readonly latencyMs?: number;
  readonly costAtomic?: string;
  readonly quotedAtomic?: string;
  /**
   * The rental, when there was one, exactly as the vendor sent it.
   *
   * Passed through untouched, credential and all, because the buyer needs the
   * credential and this is the body it arrived in. `services/trace` reduces it
   * to a hash and an expiry on the way into the file — the redaction belongs
   * at the recording boundary, not here, since a trace builder that trusts its
   * caller to have stripped the secret is trusting the component this
   * architecture assumes is compromised.
   */
  readonly lease?: unknown;
}

/**
 * Pulls the vendor's account of what it did out of a paid payload.
 *
 * Every field is optional and none is trusted: this is a third party
 * describing work the buyer cannot observe. It is recorded in the trace as
 * evidence of *what the vendor claimed*, never as a verified fact — see the
 * `vendor-upstream` step type.
 *
 * ## Two shapes, one step
 *
 * The search vendor reports an `upstream` block: an API it called, what that
 * call cost and how long it took. The GPU vendor has no upstream call to
 * report — it allocated a machine — so it reports `pricing` and either a `job`
 * or a `lease`. Both are the same claim in the end, which is what the vendor
 * says it did with the money, so both land in the same step rather than
 * growing a second step type that would have to be verified the same way.
 *
 * Returns nothing for the mock vendor's body, which carries neither block.
 */
export function vendorUpstreamOf(data: unknown): VendorUpstream | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const body = data as Record<string, unknown>;

  const upstream = body["upstream"];
  if (typeof upstream !== "object" || upstream === null) return rentalUpstreamOf(body);

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
 * The GPU vendor's version of the same claim.
 *
 * `latencyMs` is provisioning plus runtime, which is the number that matters
 * to a buyer for the same reason the search vendor's latency does: it is how
 * long the money was committed before anything came back. For a lease the run
 * has not finished when the response is written, so only provisioning counts,
 * and that is the honest figure rather than a projection of the block.
 *
 * `costAtomic` comes from `reportedCostAtomic` and is absent when the provider
 * reported nothing — which is every run against the stand-in adapter. Absent
 * is the right answer there; a zero would read as a free machine.
 */
function rentalUpstreamOf(body: Record<string, unknown>): VendorUpstream | undefined {
  const pricing = body["pricing"];
  if (typeof pricing !== "object" || pricing === null) return undefined;
  const priced = pricing as Record<string, unknown>;

  const job = (typeof body["job"] === "object" && body["job"] !== null ? body["job"] : {}) as Record<
    string,
    unknown
  >;
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const elapsed = num(job["provisionMs"]) + num(job["runMs"]);

  const digits = (value: unknown) =>
    typeof value === "string" && /^[0-9]+$/.test(value) ? value : undefined;

  const result: VendorUpstream = {
    ...(typeof job["id"] === "string" ? { requestId: job["id"] } : {}),
    ...(elapsed > 0 ? { latencyMs: elapsed } : {}),
    ...(digits(priced["reportedCostAtomic"]) === undefined
      ? {}
      : { costAtomic: digits(priced["reportedCostAtomic"]) as string }),
    ...(digits(priced["quotedAtomic"]) === undefined
      ? {}
      : { quotedAtomic: digits(priced["quotedAtomic"]) as string }),
    ...(typeof body["lease"] === "object" && body["lease"] !== null
      ? { lease: body["lease"] }
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
