/**
 * Strict parsers for x402's `auth-capture` scheme, in the one profile this system uses:
 * a custom operator, an escrowed hold, EIP-3009, no fees.
 *
 * Narrower than the scheme on purpose. The scheme also allows delegated operators, fees
 * and immediate charges, each of which is a decision about somebody's money that this
 * system has made once and does not want a 402 reopening. As in `terms.ts`: nothing is
 * coerced, a missing field is a rejection, and so is one we do not know.
 *
 * Browser-safe: no viem.
 */

import { AUTH_CAPTURE_ESCROW, ERC3009_TOKEN_COLLECTOR, type PaymentInfo } from "../chain/escrow.js";
import type { Address } from "./protocol.js";
import type { ParseResult, Terms } from "./terms.js";

export const SCHEME_AUTH_CAPTURE = "auth-capture";
/** `auth-capture` exists only in x402 v2. The `exact` flow stays on v1. */
export const X402_VERSION_V2 = 2;
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE_V2 = "PAYMENT-RESPONSE";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const MAX_UINT48 = 2 ** 48 - 1;

export interface AuthCaptureExtra {
  readonly name: string;
  readonly version: string;
  readonly authCaptureEscrow: Address;
  /** The operator. In this system, the buyer's vault. */
  readonly captureAuthorizer: Address;
  readonly operatorType: "custom";
  readonly paymentFlow: "escrow";
  readonly captureDeadline: number;
  readonly refundDeadline: number;
  readonly minFeeBps: 0;
  readonly maxFeeBps: 0;
  readonly feeRecipient: Address;
  readonly assetTransferMethod: "eip3009";
}

export interface AuthCaptureRequirements {
  readonly scheme: typeof SCHEME_AUTH_CAPTURE;
  /** CAIP-2, for example `eip155:84532`. */
  readonly network: string;
  readonly amount: string;
  readonly asset: Address;
  readonly payTo: Address;
  readonly maxTimeoutSeconds: number;
  readonly extra: AuthCaptureExtra;
}

export interface AuthCapturePayload {
  readonly x402Version: typeof X402_VERSION_V2;
  readonly resource?: { readonly url: string; readonly method: string };
  readonly accepted: AuthCaptureRequirements;
  readonly payload: {
    readonly authorization: {
      readonly from: Address;
      readonly to: Address;
      readonly value: string;
      readonly validAfter: string;
      readonly validBefore: string;
      readonly nonce: `0x${string}`;
    };
    readonly signature: `0x${string}`;
    /** 32 bytes, zero-padded. In this system it encodes the goal and sequence number. */
    readonly salt: `0x${string}`;
  };
}

const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHex32 = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const isSignature = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{130}$/.test(v);
const isUintString = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v);
const isTimestamp = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_UINT48;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function unknownField(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

const EXTRA_FIELDS = [
  "name",
  "version",
  "authCaptureEscrow",
  "captureAuthorizer",
  "operatorType",
  "paymentFlow",
  "captureDeadline",
  "refundDeadline",
  "minFeeBps",
  "maxFeeBps",
  "feeRecipient",
  "assetTransferMethod",
] as const;

function parseExtra(raw: unknown): ParseResult<AuthCaptureExtra> {
  const e = record(raw);
  if (!e) return fail("extra: expected an object");
  const extraField = unknownField(e, EXTRA_FIELDS);
  if (extraField) return fail(`extra.${extraField}: not a field this profile accepts`);

  if (typeof e["name"] !== "string" || e["name"] === "") return fail("extra.name: expected a string");
  if (typeof e["version"] !== "string" || e["version"] === "") return fail("extra.version: expected a string");
  if (!isAddress(e["authCaptureEscrow"]) || !sameAddress(e["authCaptureEscrow"], AUTH_CAPTURE_ESCROW)) {
    return fail(`extra.authCaptureEscrow: must be ${AUTH_CAPTURE_ESCROW}`);
  }
  if (!isAddress(e["captureAuthorizer"])) return fail("extra.captureAuthorizer: expected an address");
  if (e["operatorType"] !== "custom") return fail('extra.operatorType: must be "custom"');
  if (e["paymentFlow"] !== "escrow") return fail('extra.paymentFlow: must be "escrow"');
  if (!isTimestamp(e["captureDeadline"])) return fail("extra.captureDeadline: expected a timestamp");
  // The vault offers no refund, so it derives refundExpiry from the capture deadline. A
  // later value here would make the signed payment differ from the one it recomputes.
  if (e["refundDeadline"] !== e["captureDeadline"]) return fail("extra.refundDeadline: must equal captureDeadline");
  if (e["minFeeBps"] !== 0 || e["maxFeeBps"] !== 0) return fail("extra: fees must be zero");
  if (!isAddress(e["feeRecipient"]) || !sameAddress(e["feeRecipient"], ZERO_ADDRESS)) {
    return fail("extra.feeRecipient: must be the zero address");
  }
  if (e["assetTransferMethod"] !== "eip3009") return fail('extra.assetTransferMethod: must be "eip3009"');

  return { ok: true, value: e as unknown as AuthCaptureExtra };
}

const REQUIREMENT_FIELDS = ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds", "extra"] as const;

export function parseAuthCaptureRequirements(raw: unknown): ParseResult<AuthCaptureRequirements> {
  const r = record(raw);
  if (!r) return fail("requirements: expected an object");
  const extraField = unknownField(r, REQUIREMENT_FIELDS);
  if (extraField) return fail(`requirements.${extraField}: not a field this profile accepts`);

  if (r["scheme"] !== SCHEME_AUTH_CAPTURE) return fail(`scheme: must be "${SCHEME_AUTH_CAPTURE}"`);
  if (typeof r["network"] !== "string" || !/^eip155:[1-9][0-9]*$/.test(r["network"])) {
    return fail("network: expected a CAIP-2 EVM network");
  }
  if (!isUintString(r["amount"]) || r["amount"] === "0") return fail("amount: expected a positive integer string");
  if (!isAddress(r["asset"])) return fail("asset: expected an address");
  if (!isAddress(r["payTo"])) return fail("payTo: expected an address");
  const timeout = r["maxTimeoutSeconds"];
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0 || timeout > 86_400) {
    return fail("maxTimeoutSeconds: expected a positive integer no greater than a day");
  }
  const extra = parseExtra(r["extra"]);
  if (!extra.ok) return extra;

  return { ok: true, value: { ...(r as unknown as AuthCaptureRequirements), extra: extra.value } };
}

export function parseAuthCapturePayload(raw: unknown): ParseResult<AuthCapturePayload> {
  const p = record(raw);
  if (!p) return fail("payload: expected an object");
  const extraField = unknownField(p, ["x402Version", "resource", "accepted", "payload"]);
  if (extraField) return fail(`payload.${extraField}: not a field this profile accepts`);
  if (p["x402Version"] !== X402_VERSION_V2) return fail(`x402Version: must be ${X402_VERSION_V2}`);

  if (p["resource"] !== undefined) {
    const resource = record(p["resource"]);
    if (!resource || typeof resource["url"] !== "string" || typeof resource["method"] !== "string") {
      return fail("resource: expected a url and a method");
    }
  }

  const accepted = parseAuthCaptureRequirements(p["accepted"]);
  if (!accepted.ok) return accepted;

  const inner = record(p["payload"]);
  if (!inner) return fail("payload.payload: expected an object");
  const innerField = unknownField(inner, ["authorization", "signature", "salt"]);
  if (innerField) return fail(`payload.${innerField}: not a field this profile accepts`);
  const a = record(inner["authorization"]);
  if (!a) return fail("authorization: expected an object");
  if (!isAddress(a["from"])) return fail("authorization.from: expected an address");
  if (!isAddress(a["to"]) || !sameAddress(a["to"], ERC3009_TOKEN_COLLECTOR)) {
    return fail(`authorization.to: must be the collector ${ERC3009_TOKEN_COLLECTOR}`);
  }
  if (!isUintString(a["value"])) return fail("authorization.value: expected an integer string");
  if (a["validAfter"] !== "0") return fail('authorization.validAfter: must be "0"');
  if (!isUintString(a["validBefore"])) return fail("authorization.validBefore: expected an integer string");
  if (!isHex32(a["nonce"])) return fail("authorization.nonce: expected 32 bytes of hex");
  if (!isSignature(inner["signature"])) return fail("signature: expected 65 bytes of hex");
  if (!isHex32(inner["salt"])) return fail("salt: expected 32 bytes of hex");
  if (a["value"] !== accepted.value.amount) return fail("authorization.value: must equal the amount");

  return { ok: true, value: { ...(p as unknown as AuthCapturePayload), accepted: accepted.value } };
}

/** A parsed v2 402. `accepts` holds only the offers this profile can pay. */
export interface AuthCapturePaymentRequired {
  readonly x402Version: typeof X402_VERSION_V2;
  readonly accepts: readonly AuthCaptureRequirements[];
  readonly resource: {
    readonly url: string;
    /** Written by the vendor. Attacker-controlled, as in `Terms.description`. */
    readonly description: string;
  };
  /** Why the server is still asking, on a retry. Written by the vendor. */
  readonly error?: string | undefined;
}

/**
 * Parses a decoded `PAYMENT-REQUIRED`. Offers under other schemes are dropped, since a
 * vendor may list several, and an `auth-capture` offer outside this profile rejects the
 * whole 402: it is a vendor asking for something this system has decided not to do, and
 * quietly picking another of its offers would be guessing what it meant.
 */
export function parseAuthCapturePaymentRequired(raw: unknown): ParseResult<AuthCapturePaymentRequired> {
  const p = record(raw);
  if (!p) return fail("body: expected an object");
  if (p["x402Version"] !== X402_VERSION_V2) return fail(`x402Version: must be ${X402_VERSION_V2}`);
  if (!Array.isArray(p["accepts"])) return fail("accepts: expected an array");

  const resource = record(p["resource"]);
  if (!resource) return fail("resource: expected an object");
  const url = resource["url"];
  if (typeof url !== "string" || !URL.canParse(url)) return fail("resource.url: expected an absolute URL");
  const description = resource["description"];
  if (typeof description !== "string" || description === "") {
    return fail("resource.description: expected a string");
  }

  const accepts: AuthCaptureRequirements[] = [];
  for (const entry of p["accepts"] as unknown[]) {
    if (record(entry)?.["scheme"] !== SCHEME_AUTH_CAPTURE) continue;
    const parsed = parseAuthCaptureRequirements(entry);
    if (!parsed.ok) return fail(`accepts: ${parsed.error}`);
    accepts.push(parsed.value);
  }
  if (accepts.length === 0) return fail(`accepts: no ${SCHEME_AUTH_CAPTURE} offer`);

  const error = p["error"];
  return {
    ok: true,
    value: {
      x402Version: X402_VERSION_V2,
      accepts,
      resource: { url, description },
      ...(typeof error === "string" && error !== "" ? { error } : {}),
    },
  };
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeJson<T>(header: string, name: string, parse: (raw: unknown) => ParseResult<T>): ParseResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch (e) {
    return fail(`${name}: not base64 JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  return parse(raw);
}

export const encodePaymentRequiredHeader = (value: unknown): string => encodeJson(value);
export const encodePaymentSignatureHeader = (payload: AuthCapturePayload): string => encodeJson(payload);

export function decodePaymentRequiredHeader(header: string): ParseResult<AuthCapturePaymentRequired> {
  return decodeJson(header, HEADER_PAYMENT_REQUIRED, parseAuthCapturePaymentRequired);
}

export function decodePaymentSignatureHeader(header: string): ParseResult<AuthCapturePayload> {
  return decodeJson(header, HEADER_PAYMENT_SIGNATURE, parseAuthCapturePayload);
}

/** What we require of an offer before it is worth considering at all. */
export interface ExpectedEscrowOffer {
  readonly network: string;
  readonly asset: Address;
  /** The buyer's own vault. A vendor naming any other operator cannot be paid. */
  readonly operator: Address;
}

/**
 * Chooses the first offer matching our own configuration, as `selectTerms` does. The 402
 * is a claim, and the operator most of all: it is the contract whose checks stand between
 * a signature and the money.
 */
export function selectEscrowOffer(
  parsed: AuthCapturePaymentRequired,
  expected: ExpectedEscrowOffer,
): ParseResult<AuthCaptureRequirements> {
  const match = parsed.accepts.find(
    (offer) =>
      offer.network === expected.network &&
      sameAddress(offer.asset, expected.asset) &&
      sameAddress(offer.extra.captureAuthorizer, expected.operator),
  );
  if (match) return { ok: true, value: match };
  const offered = parsed.accepts.map((o) => `${o.network}/${o.asset}/${o.extra.captureAuthorizer}`).join(", ");
  return fail(
    `no offer matches ${expected.network}/${expected.asset} with this vault (${expected.operator}) ` +
      `as operator; offered: ${offered}`,
  );
}

/** The same `Terms` the `exact` flow uses, so the agent and the trace see one shape. */
export function termsFromOffer(offer: AuthCaptureRequirements, parsed: AuthCapturePaymentRequired): Terms {
  return {
    scheme: SCHEME_AUTH_CAPTURE,
    network: offer.network,
    asset: offer.asset,
    payTo: offer.payTo,
    amount: BigInt(offer.amount),
    resource: parsed.resource.url,
    description: parsed.resource.description,
    maxTimeoutSeconds: offer.maxTimeoutSeconds,
    extra: offer.extra as unknown as Readonly<Record<string, unknown>>,
  };
}

/** A payment salt as the 32 bytes of hex the wire carries. */
export function saltToHex(salt: bigint): `0x${string}` {
  return `0x${salt.toString(16).padStart(64, "0")}`;
}

/** The reverse of `paymentSalt`. A vendor reads these out of the salt to claim. */
export function splitPaymentSalt(salt: `0x${string}`): { goalId: bigint; seq: bigint } {
  const value = BigInt(salt);
  return { goalId: value >> 64n, seq: value & (2n ** 64n - 1n) };
}

/** Rebuilds the on-chain `PaymentInfo` a payload describes. */
export function paymentInfoFromWire(payload: AuthCapturePayload): PaymentInfo {
  const { accepted } = payload;
  return {
    operator: accepted.extra.captureAuthorizer,
    payer: payload.payload.authorization.from,
    receiver: accepted.payTo,
    token: accepted.asset,
    maxAmount: BigInt(accepted.amount),
    preApprovalExpiry: Number(payload.payload.authorization.validBefore),
    authorizationExpiry: accepted.extra.captureDeadline,
    refundExpiry: accepted.extra.refundDeadline,
    minFeeBps: 0,
    maxFeeBps: 0,
    feeReceiver: ZERO_ADDRESS,
    salt: BigInt(payload.payload.salt),
  };
}
