/**
 * The signer's request schema. This file is the enforcement point for
 * non-negotiable #2 (ARCHITECTURE.md): the request carries `(goalId, seq)`
 * and **nothing else**.
 *
 * Not "validate and ignore" — an unknown key is a hard rejection. The
 * difference matters: a schema that tolerates an extra `amount` invites the
 * next person to start reading it, and at that moment the signer has a second
 * source of truth and the whole design collapses. Rejecting means the mistake
 * shows up as a failing request instead of a silent policy bypass.
 *
 * `FORBIDDEN_HINTS` exists only to make that failure legible. Any unknown key
 * is refused whether or not it appears in the list.
 */

export interface SignRequest {
  readonly goalId: bigint;
  readonly seq: bigint;
}

export type SchemaResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const ALLOWED_KEYS = new Set(["goalId", "seq"]);

/**
 * Terms fields a caller might plausibly try to pass. Present purely so the
 * error message can say *why* it is refused rather than "unknown key".
 */
const FORBIDDEN_HINTS = new Set([
  "amount",
  "value",
  "payTo",
  "to",
  "from",
  "payer",
  "asset",
  "token",
  "resource",
  "terms",
  "termsHash",
  "nonce",
  "validAfter",
  "validBefore",
  "network",
  "chainId",
  "recipient",
  "description",
]);

/**
 * Accepts a decimal string or a non-negative safe integer. Strings are the
 * canonical JSON form for a uint256; a float or a negative is a rejection, not
 * something to round.
 */
function parseUint(raw: unknown, field: string, max: bigint): SchemaResult<bigint> {
  let value: bigint;
  if (typeof raw === "string") {
    if (!/^[0-9]+$/.test(raw)) {
      return { ok: false, error: `${field}: expected digits only, got ${JSON.stringify(raw)}` };
    }
    value = BigInt(raw);
  } else if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      return { ok: false, error: `${field}: expected a non-negative safe integer, got ${raw}` };
    }
    value = BigInt(raw);
  } else if (typeof raw === "bigint") {
    if (raw < 0n) return { ok: false, error: `${field}: must not be negative` };
    value = raw;
  } else {
    return {
      ok: false,
      error: `${field}: expected a decimal string or integer, got ${raw === null ? "null" : typeof raw}`,
    };
  }
  if (value > max) return { ok: false, error: `${field}: out of range` };
  return { ok: true, value };
}

const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_UINT64 = 2n ** 64n - 1n;

export function parseSignRequest(raw: unknown): SchemaResult<SignRequest> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `body: expected an object, got ${raw === null ? "null" : typeof raw}` };
  }

  const body = raw as Record<string, unknown>;

  // Rejected *before* the valid fields are read, so a request carrying terms
  // can never be partially honoured.
  const extra = Object.keys(body).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length > 0) {
    const terms = extra.filter((k) => FORBIDDEN_HINTS.has(k));
    if (terms.length > 0) {
      return {
        ok: false,
        error:
          `refused: the request carries payment terms (${terms.join(", ")}). ` +
          `The signer accepts (goalId, seq) only and reads every field it signs from the ` +
          `finalized on-chain record. Terms supplied by a caller are not a source of truth.`,
      };
    }
    return {
      ok: false,
      error: `refused: unknown field(s) ${extra.join(", ")}. The signer accepts (goalId, seq) only.`,
    };
  }

  if (!("goalId" in body)) return { ok: false, error: "goalId: missing" };
  if (!("seq" in body)) return { ok: false, error: "seq: missing" };

  const goalId = parseUint(body["goalId"], "goalId", MAX_UINT256);
  if (!goalId.ok) return goalId;

  const seq = parseUint(body["seq"], "seq", MAX_UINT64);
  if (!seq.ok) return seq;

  if (seq.value === 0n) {
    return { ok: false, error: "seq: must be >= 1; sequence numbers start at 1" };
  }

  return { ok: true, value: { goalId: goalId.value, seq: seq.value } };
}

/**
 * The sweep body: `{ goalId }` and nothing else.
 *
 * Separate from `parseSignRequest` rather than reusing it with an optional
 * `seq`, so that "a sweep cannot carry a destination or an amount" is visible
 * in the type rather than being a property of how the handler happens to read
 * it.
 */
export function parseSweepRequest(raw: unknown): SchemaResult<{ goalId: bigint }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `body: expected an object, got ${raw === null ? "null" : typeof raw}` };
  }

  const body = raw as Record<string, unknown>;

  /*
   * Refused, not ignored.
   *
   * An earlier version read `goalId` and let everything else fall on the floor,
   * on the reasoning that ignoring a field is as safe as rejecting it. For this
   * service it is not. Non-negotiable #2 is explicit — terms fields "must not be
   * in the schema at all", and specifically "not 'validate and ignore them'" —
   * because the argument the signer rests on is that its API has no way to
   * express a destination or an amount. A body carrying `to` and `value` that
   * still returns a signature undermines that argument even when the values
   * were discarded, and it is the reading of the code, not the runtime
   * behaviour, that a reviewer checks.
   */
  const extra = Object.keys(body).filter((k) => k !== "goalId");
  if (extra.length > 0) {
    const terms = extra.filter((k) => FORBIDDEN_HINTS.has(k));
    if (terms.length > 0) {
      return {
        ok: false,
        error:
          `refused: the request carries payment terms (${terms.join(", ")}). ` +
          `A sweep accepts (goalId) only. The destination is the goal owner recorded on chain ` +
          `and the amount is the payer's whole balance; neither is a caller's to choose.`,
      };
    }
    return {
      ok: false,
      error: `refused: unknown field(s) ${extra.join(", ")}. A sweep accepts (goalId) only.`,
    };
  }

  const goalId = body["goalId"];
  if (typeof goalId !== "string" || !/^[0-9]{1,32}$/.test(goalId)) {
    return { ok: false, error: "body.goalId: expected a decimal string" };
  }
  return { ok: true, value: { goalId: BigInt(goalId) } };
}
