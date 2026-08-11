/**
 * Strict parser for the x402 v1 payment-requirements payload.
 *
 * Two rules from the plan govern every line here:
 *
 *  - §6.1 — no string coercion, no defaulted missing fields. A field that is
 *    absent, null, or of the wrong type is a *rejection*, never a fallback.
 *  - §6.2 — parsed terms are **values, not instructions**. The resource server
 *    is the source of attacker-controlled input; nothing it sends may reach an
 *    LLM context as free text before the policy check runs. See
 *    `toModelSafeSummary`.
 *
 * The wire field is `maxAmountRequired`; our internal field is `amount`, derived
 * from it. The two names stay distinct so a parser bug cannot silently
 * substitute one for the other.
 */

import {
  SCHEME_EXACT,
  X402_VERSION,
  type Address,
} from "./protocol.js";

const MAX_UINT256 = 2n ** 256n - 1n;
/** One day. A 402 demanding a longer settlement window is not something we honour. */
const MAX_TIMEOUT_SECONDS = 86_400;

/**
 * Validated payment terms for a single `accepts[]` entry.
 *
 * Every field has been type-checked. `description` and `extra` are still
 * attacker-controlled *content* — validated as data, never trusted as meaning.
 */
export interface Terms {
  readonly scheme: typeof SCHEME_EXACT;
  readonly network: string;
  readonly asset: Address;
  readonly payTo: Address;
  /** Atomic units, derived from the wire's `maxAmountRequired`. */
  readonly amount: bigint;
  readonly resource: string;
  /**
   * Free text chosen by the resource server. Preserved verbatim so the trace
   * can show exactly what was sent — including an injection attempt. Never
   * interpolate this into a prompt; see `toModelSafeSummary`.
   */
  readonly description: string;
  readonly maxTimeoutSeconds: number;
  /** Server-supplied claims (e.g. `name`/`version`). Claims, not configuration. */
  readonly extra: Readonly<Record<string, unknown>> | undefined;
}

/** A parsed 402 body. `accepts` is non-empty by construction. */
export interface PaymentRequired {
  readonly x402Version: number;
  readonly accepts: readonly Terms[];
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** Thrown internally by the validators; converted to a `ParseResult` at the boundary. */
class InvalidPayload extends Error {}

function fail(message: string): never {
  throw new InvalidPayload(message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Requires an actual string. A number is a rejection, not something to `String()`. */
function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string") {
    fail(`${where}.${key}: expected string, got ${describe(v)}`);
  }
  if (v.length === 0) fail(`${where}.${key}: must not be empty`);
  return v;
}

function requireAddress(obj: Record<string, unknown>, key: string, where: string): Address {
  const v = requireString(obj, key, where);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    fail(`${where}.${key}: expected a 20-byte hex address, got ${JSON.stringify(v)}`);
  }
  return v as Address;
}

/**
 * x402 carries amounts as decimal strings in atomic units, precisely so nobody
 * routes them through a float. We reject anything that isn't plain digits:
 * no signs, no decimal point, no exponent, no hex, no whitespace.
 */
function requireAtomicAmount(obj: Record<string, unknown>, key: string, where: string): bigint {
  const v = obj[key];
  if (typeof v !== "string") {
    fail(`${where}.${key}: expected a decimal string in atomic units, got ${describe(v)}`);
  }
  if (!/^[0-9]+$/.test(v)) {
    fail(`${where}.${key}: expected digits only, got ${JSON.stringify(v)}`);
  }
  const parsed = BigInt(v);
  if (parsed > MAX_UINT256) fail(`${where}.${key}: exceeds uint256`);
  return parsed;
}

/** Requires a real integer. A numeric string is a rejection, not something to `Number()`. */
function requireInteger(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  { min, max }: { min: number; max: number },
): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    fail(`${where}.${key}: expected an integer, got ${describe(v)}`);
  }
  if (v < min || v > max) fail(`${where}.${key}: out of range [${min}, ${max}], got ${v}`);
  return v;
}

/**
 * `resource` reaches the model-safe summary, so we bound it to something
 * URL-shaped rather than letting it be an arbitrary prose carrier.
 */
function requireResource(obj: Record<string, unknown>, where: string): string {
  const v = requireString(obj, "resource", where);
  const looksAbsolute = URL.canParse(v);
  const looksLikePath = v.startsWith("/") && !/\s/.test(v);
  if (!looksAbsolute && !looksLikePath) {
    fail(`${where}.resource: expected an absolute URL or a path, got ${JSON.stringify(v)}`);
  }
  return v;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined (missing)";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function parseTermsEntry(raw: unknown, where: string): Terms {
  if (!isPlainObject(raw)) fail(`${where}: expected an object, got ${describe(raw)}`);

  const scheme = requireString(raw, "scheme", where);
  if (scheme !== SCHEME_EXACT) {
    fail(`${where}.scheme: only ${JSON.stringify(SCHEME_EXACT)} is supported, got ${JSON.stringify(scheme)}`);
  }

  const extraRaw = raw["extra"];
  if (extraRaw !== undefined && !isPlainObject(extraRaw)) {
    fail(`${where}.extra: expected an object when present, got ${describe(extraRaw)}`);
  }

  return {
    scheme: SCHEME_EXACT,
    network: requireString(raw, "network", where),
    asset: requireAddress(raw, "asset", where),
    payTo: requireAddress(raw, "payTo", where),
    amount: requireAtomicAmount(raw, "maxAmountRequired", where),
    resource: requireResource(raw, where),
    description: requireString(raw, "description", where),
    maxTimeoutSeconds: requireInteger(raw, "maxTimeoutSeconds", where, {
      min: 1,
      max: MAX_TIMEOUT_SECONDS,
    }),
    extra: extraRaw as Readonly<Record<string, unknown>> | undefined,
  };
}

/**
 * Parses a 402 response body. Unknown top-level and per-entry fields are
 * dropped rather than passed through, so a server cannot smuggle extra keys
 * into anything downstream.
 */
export function parsePaymentRequired(raw: unknown): ParseResult<PaymentRequired> {
  try {
    if (!isPlainObject(raw)) {
      fail(`body: expected an object, got ${describe(raw)}`);
    }

    const version = raw["x402Version"];
    if (version !== X402_VERSION) {
      fail(`body.x402Version: expected ${X402_VERSION}, got ${describe(version)}${
        typeof version === "number" || typeof version === "string" ? ` (${JSON.stringify(version)})` : ""
      }`);
    }

    const accepts = raw["accepts"];
    if (!Array.isArray(accepts)) {
      fail(`body.accepts: expected an array, got ${describe(accepts)}`);
    }
    if (accepts.length === 0) {
      fail("body.accepts: must contain at least one entry");
    }

    const parsed = accepts.map((entry, i) => parseTermsEntry(entry, `accepts[${i}]`));
    return { ok: true, value: { x402Version: X402_VERSION, accepts: parsed } };
  } catch (e) {
    if (e instanceof InvalidPayload) return { ok: false, error: e.message };
    throw e;
  }
}

/** What we require of a 402 before it is worth considering at all. */
export interface ExpectedPayment {
  readonly network: string;
  readonly asset: Address;
}

/**
 * Selects the first entry matching our own configuration.
 *
 * The 402 body is a claim, not a source of configuration (ARCHITECTURE.md §7.7 / IMPLEMENTATION.md §8):
 * we filter the server's offers against what *we* already decided, rather than
 * adopting whatever it names. Address comparison is case-insensitive because
 * EIP-55 checksumming is presentational.
 */
export function selectTerms(
  parsed: PaymentRequired,
  expected: ExpectedPayment,
): ParseResult<Terms> {
  const match = parsed.accepts.find(
    (t) =>
      t.network === expected.network &&
      t.asset.toLowerCase() === expected.asset.toLowerCase(),
  );
  if (!match) {
    const offered = parsed.accepts
      .map((t) => `${t.network}/${t.asset}`)
      .join(", ");
    return {
      ok: false,
      error: `no accepts[] entry matches ${expected.network}/${expected.asset}; offered: ${offered}`,
    };
  }
  return { ok: true, value: match };
}

/**
 * The typed, non-free-text projection of terms — the **only** form that may
 * reach an LLM context (ARCHITECTURE.md §6.1).
 *
 * `description` and `extra` are omitted precisely because they are where an
 * injection arrives. Dropping them here is what makes "the component that
 * decides never reads the attacker's text" true in code rather than in prose.
 * The full text is still preserved on `Terms` for the trace and the UI.
 */
export interface ModelSafeTerms {
  readonly scheme: string;
  readonly network: string;
  readonly asset: Address;
  readonly payTo: Address;
  /** Serialised because JSON cannot carry a bigint. */
  readonly amountAtomic: string;
  readonly resource: string;
  readonly maxTimeoutSeconds: number;
}

export function toModelSafeSummary(terms: Terms): ModelSafeTerms {
  return {
    scheme: terms.scheme,
    network: terms.network,
    asset: terms.asset,
    payTo: terms.payTo,
    amountAtomic: terms.amount.toString(),
    resource: terms.resource,
    maxTimeoutSeconds: terms.maxTimeoutSeconds,
  };
}
