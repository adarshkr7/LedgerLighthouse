/**
 * The x402 **v1** `exact` scheme payment payload — the thing that travels in the
 * `X-PAYMENT` header, and the facilitator's request/response shapes.
 *
 * Parsed with the same discipline as the 402 body (see `terms.ts`): no
 * coercion, no defaults. A facilitator receives this from a resource server
 * which received it from an agent, so by the time it is read here it has
 * crossed two trust boundaries. It is data.
 *
 * Header encoding is base64 of the JSON. Amounts are decimal strings for the
 * same reason they are in the 402 body — nothing that represents money goes
 * near a float.
 */

import { SCHEME_EXACT, X402_VERSION, type Address } from "./protocol.js";
import type { ParseResult } from "./terms.js";

/** The EIP-3009 tuple, on the wire. Field names match the token's own. */
export interface WireAuthorization {
  readonly from: Address;
  readonly to: Address;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: `0x${string}`;
}

export interface PaymentPayload {
  readonly x402Version: number;
  readonly scheme: typeof SCHEME_EXACT;
  readonly network: string;
  readonly payload: {
    readonly signature: `0x${string}`;
    readonly authorization: WireAuthorization;
  };
}

/** What the resource server tells the facilitator it expects to be paid. */
export interface PaymentRequirements {
  readonly scheme: typeof SCHEME_EXACT;
  readonly network: string;
  readonly asset: Address;
  readonly payTo: Address;
  /** Wire name, kept distinct from our internal `amount` throughout. */
  readonly maxAmountRequired: string;
  readonly resource: string;
}

export interface VerifyResponse {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly payer?: Address;
}

export interface SettleResponse {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly transaction?: `0x${string}`;
  readonly network?: string;
  readonly payer?: Address;
  /**
   * True when the authorization had already been consumed on chain. The
   * settlement is still a success — that is the whole point of a deterministic
   * nonce and a frozen window (ARCHITECTURE.md §7.4) — but the caller deserves to know it
   * did not move money a second time.
   */
  readonly alreadySettled?: boolean;
  /**
   * True when no facilitator was wired in and nothing was submitted on chain.
   * Present so a stubbed run can never be mistaken for a real one — a demo that
   * reports success without moving money is worse than one that fails loudly.
   */
  readonly simulated?: boolean;
}

// --------------------------------------------------------------- encode/decode

export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function encodeSettlementHeader(response: SettleResponse): string {
  return Buffer.from(JSON.stringify(response), "utf8").toString("base64");
}

export function decodeSettlementHeader(header: string): ParseResult<SettleResponse> {
  try {
    const json: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (typeof json !== "object" || json === null) {
      return { ok: false, error: "X-PAYMENT-RESPONSE: expected an object" };
    }
    return { ok: true, value: json as SettleResponse };
  } catch (e) {
    return {
      ok: false,
      error: `X-PAYMENT-RESPONSE: not base64 JSON (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

// ---------------------------------------------------------------------- parse

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v === "") {
    throw new Error(`${where}.${key}: expected a non-empty string`);
  }
  return v;
}

function addr(obj: Record<string, unknown>, key: string, where: string): Address {
  const v = str(obj, key, where);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${where}.${key}: expected an address`);
  return v as Address;
}

function digits(obj: Record<string, unknown>, key: string, where: string): string {
  const v = str(obj, key, where);
  if (!/^[0-9]+$/.test(v)) throw new Error(`${where}.${key}: expected digits only`);
  return v;
}

function hex32(obj: Record<string, unknown>, key: string, where: string): `0x${string}` {
  const v = str(obj, key, where);
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${where}.${key}: expected 32 bytes of hex`);
  return v as `0x${string}`;
}

/** Parses the decoded `X-PAYMENT` body. Rejects a v2-shaped payload rather than adapting. */
export function parsePaymentPayload(raw: unknown): ParseResult<PaymentPayload> {
  try {
    if (!isPlainObject(raw)) throw new Error("payment: expected an object");
    if (raw["x402Version"] !== X402_VERSION) {
      throw new Error(`payment.x402Version: expected ${X402_VERSION}`);
    }
    if (raw["scheme"] !== SCHEME_EXACT) {
      throw new Error(`payment.scheme: only ${JSON.stringify(SCHEME_EXACT)} is supported`);
    }
    const network = str(raw, "network", "payment");

    const payload = raw["payload"];
    if (!isPlainObject(payload)) throw new Error("payment.payload: expected an object");

    const signature = str(payload, "signature", "payment.payload");
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new Error("payment.payload.signature: expected a 65-byte hex signature");
    }

    const auth = payload["authorization"];
    if (!isPlainObject(auth)) throw new Error("payment.payload.authorization: expected an object");
    const where = "payment.payload.authorization";

    return {
      ok: true,
      value: {
        x402Version: X402_VERSION,
        scheme: SCHEME_EXACT,
        network,
        payload: {
          signature: signature as `0x${string}`,
          authorization: {
            from: addr(auth, "from", where),
            to: addr(auth, "to", where),
            value: digits(auth, "value", where),
            validAfter: digits(auth, "validAfter", where),
            validBefore: digits(auth, "validBefore", where),
            nonce: hex32(auth, "nonce", where),
          },
        },
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function decodePaymentHeader(header: string): ParseResult<PaymentPayload> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch (e) {
    return {
      ok: false,
      error: `X-PAYMENT: not base64 JSON (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  return parsePaymentPayload(json);
}

export function parsePaymentRequirements(raw: unknown): ParseResult<PaymentRequirements> {
  try {
    if (!isPlainObject(raw)) throw new Error("requirements: expected an object");
    if (raw["scheme"] !== SCHEME_EXACT) {
      throw new Error(`requirements.scheme: only ${JSON.stringify(SCHEME_EXACT)} is supported`);
    }
    return {
      ok: true,
      value: {
        scheme: SCHEME_EXACT,
        network: str(raw, "network", "requirements"),
        asset: addr(raw, "asset", "requirements"),
        payTo: addr(raw, "payTo", "requirements"),
        maxAmountRequired: digits(raw, "maxAmountRequired", "requirements"),
        resource: str(raw, "resource", "requirements"),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
