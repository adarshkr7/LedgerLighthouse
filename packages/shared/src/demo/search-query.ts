/**
 * Validation for the one field a viewer gets to type.
 *
 * ## One definition, applied twice, for different reasons
 *
 * The orchestrator runs this at `POST /runs` and the vendor runs it again on
 * the request it receives. That is not redundancy, because the two checks are
 * not doing the same job.
 *
 * The orchestrator's is the courteous one: it fails fast and hands the browser
 * a usable message before any chain write happens. The vendor's is the
 * load-bearing one, because of who is calling it — the orchestrator is the
 * component this architecture assumes is compromised, and the vendor is the one
 * holding a key that spends real money. A vendor that trusts its caller to have
 * sanitised the input has moved the trust boundary to the wrong side of the
 * wire.
 *
 * It lives here so the two can never disagree about the limit. The boundary
 * check forbids the orchestrator from importing the vendor, so a shared module
 * is the only place a single definition can sit.
 *
 * ## Reject, never repair
 *
 * The 402 parser in `@ntux402/shared` sets the house rule: a field that is
 * absent, malformed or the wrong type is a rejection, not something to coerce
 * into shape. Silently truncating an over-long query or stripping control
 * characters out of one would mean the thing we searched for is not the thing
 * the caller asked for — and the query ends up in the x402 `resource` field,
 * which the vault hashes into `termsHash`. Quietly editing it edits what gets
 * signed.
 */

import { findSearchTier, type SearchTier } from "./search-tiers.js";

/**
 * Longest query accepted.
 *
 * Generous for a search box and mean for a payload: real queries are a handful
 * of words, and the length cap is one of the few things standing between a
 * free-text field and an API billed per call.
 */
export const MAX_QUERY_LENGTH = 256;

/**
 * C0 controls and DEL.
 *
 * Refused rather than escaped. They cannot survive `encodeURIComponent` into
 * anything dangerous, but they can forge structure in a log line and in the
 * trace — and the trace is the evidence artifact, so text that can fake a
 * second line of it does not get in.
 */

function hasControlChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** A query that is safe to bill for, encode into a URL, and record in a trace. */
export function validateQuery(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string") {
    return { ok: false, error: `q: expected a string, got ${raw === null ? "null" : typeof raw}` };
  }

  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "q: must not be empty" };

  if (trimmed.length > MAX_QUERY_LENGTH) {
    return {
      ok: false,
      error: `q: ${trimmed.length} characters exceeds the ${MAX_QUERY_LENGTH} limit`,
    };
  }

  if (hasControlChars(trimmed)) {
    return { ok: false, error: "q: control characters are not accepted" };
  }

  return { ok: true, value: trimmed };
}

/**
 * Resolves a tier name to its priced definition.
 *
 * The caller names a tier; it never sends a price, a depth or a result count.
 * That is the whole reason tiers exist — see `search-tiers.ts`. A request that
 * could dial `search_depth` could dial our cost, and a request that could dial
 * `maxAmountRequired` could dial what the vault is asked to approve.
 */
export function validateTier(raw: unknown): ValidationResult<SearchTier> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: findSearchTier("basic") as SearchTier };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: `tier: expected a string, got ${typeof raw}` };
  }

  const tier = findSearchTier(raw);
  if (!tier) return { ok: false, error: `tier: unknown tier ${JSON.stringify(raw)}` };
  return { ok: true, value: tier };
}
