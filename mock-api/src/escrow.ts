/**
 * The vendor's side of an escrowed x402 payment.
 *
 * Unlike the `exact` flow this vendor does hold a key, because of what escrow changes
 * about being paid: the facilitator only places the hold, and the money reaches the
 * vendor when the vendor itself calls `claim` on the buyer's vault. `claim` insists on
 * the payee as sender, so the catalog's placeholder payees cannot be paid this way, and
 * every entry pays this one address instead.
 *
 * The order below is the honest one: hold, then claim, then deliver. Nothing here makes
 * delivery conditional on anything yet. That needs the key hash, which comes with signed
 * offers. Until then a vendor can claim and deliver nothing, within the bound.
 */

import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE_V2,
  HEADER_PAYMENT_SIGNATURE,
  SCHEME_AUTH_CAPTURE,
  X402_VERSION_V2,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodeSettlementHeader,
  splitPaymentSalt,
  AUTH_CAPTURE_ESCROW,
  type Address,
  type AuthCapturePayload,
  type AuthCaptureRequirements,
  type SettleResponse,
} from "@ntux402/shared";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** How long after the hold ends this vendor may still claim. */
const DEFAULT_CAPTURE_WINDOW_SECONDS = 300;

export type ClaimOutcome =
  | { readonly ok: true; readonly transaction?: `0x${string}` | undefined }
  | { readonly ok: false; readonly reason: string };

export interface EscrowGateway {
  /** Places the hold, through the facilitator. */
  settle(payment: AuthCapturePayload, requirements: AuthCaptureRequirements): Promise<SettleResponse>;
  /** Takes the held payment. Succeeds without sending anything if it was already taken. */
  claim(goalId: bigint, seq: bigint, payment: AuthCapturePayload): Promise<ClaimOutcome>;
}

export interface EscrowVendorOptions {
  /** The operator this vendor accepts. The buyer's vault. */
  readonly vault: Address;
  /** The address paid, and the one that sends `claim`. */
  readonly vendor: Address;
  /** CAIP-2, for example `eip155:84532`. */
  readonly network: string;
  readonly asset: Address;
  readonly maxTimeoutSeconds: number;
  readonly gateway: EscrowGateway;
  readonly captureWindowSeconds?: number;
  /** Seconds since the epoch. Tests replace it. */
  readonly now?: () => number;
}

export interface EscrowRoute {
  readonly amountAtomic: string;
  readonly description: string;
  readonly resource: string;
}

export interface EscrowResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** True when the vendor has been paid and may deliver. */
  readonly paid?: boolean;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

function offer(options: EscrowVendorOptions, route: EscrowRoute): AuthCaptureRequirements {
  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  const captureDeadline =
    now + options.maxTimeoutSeconds + (options.captureWindowSeconds ?? DEFAULT_CAPTURE_WINDOW_SECONDS);
  return {
    scheme: SCHEME_AUTH_CAPTURE,
    network: options.network,
    amount: route.amountAtomic,
    asset: options.asset,
    payTo: options.vendor,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
    extra: {
      name: "USDC",
      version: "2",
      authCaptureEscrow: AUTH_CAPTURE_ESCROW,
      captureAuthorizer: options.vault,
      operatorType: "custom",
      paymentFlow: "escrow",
      captureDeadline,
      refundDeadline: captureDeadline,
      minFeeBps: 0,
      maxFeeBps: 0,
      feeRecipient: ZERO_ADDRESS,
      assetTransferMethod: "eip3009",
    },
  };
}

function paymentRequired(options: EscrowVendorOptions, route: EscrowRoute, error: string): EscrowResponse {
  return {
    status: 402,
    headers: {
      ...JSON_HEADERS,
      [HEADER_PAYMENT_REQUIRED]: encodePaymentRequiredHeader({
        x402Version: X402_VERSION_V2,
        error,
        resource: { url: route.resource, description: route.description, mimeType: "application/json" },
        accepts: [offer(options, route)],
      }),
    },
    // Where a v2 server carries these is the header. A body is its own business.
    body: {},
  };
}

/**
 * The buyer's accepted offer comes back on the retry, and this vendor keeps no state, so
 * it checks the offer is one it would have made instead of remembering it. Refusing here
 * costs nothing: no hold has been placed.
 */
function refusal(options: EscrowVendorOptions, route: EscrowRoute, payment: AuthCapturePayload): string | undefined {
  const accepted = payment.accepted;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (accepted.amount !== route.amountAtomic) return `amount ${accepted.amount} is not this resource's price`;
  if (!same(accepted.payTo, options.vendor)) return "the payment does not pay this vendor";
  if (!same(accepted.asset, options.asset)) return "the payment is in another token";
  if (accepted.network !== options.network) return "the payment is on another network";
  if (!same(accepted.extra.captureAuthorizer, options.vault)) return "the payment names another operator";

  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  const latest = now + options.maxTimeoutSeconds + (options.captureWindowSeconds ?? DEFAULT_CAPTURE_WINDOW_SECONDS);
  if (accepted.extra.captureDeadline <= now) return "the capture deadline has passed";
  if (accepted.extra.captureDeadline > latest) return "the capture deadline is later than this vendor offers";
  return undefined;
}

export async function handleEscrowRequest(
  headers: Readonly<Record<string, string | undefined>>,
  route: EscrowRoute,
  options: EscrowVendorOptions,
): Promise<EscrowResponse> {
  const header = headers[HEADER_PAYMENT_SIGNATURE.toLowerCase()] ?? headers[HEADER_PAYMENT_SIGNATURE];
  if (header === undefined || header === "") {
    return paymentRequired(options, route, `${HEADER_PAYMENT_SIGNATURE} header is required`);
  }

  const decoded = decodePaymentSignatureHeader(header);
  if (!decoded.ok) return paymentRequired(options, route, `payment rejected: ${decoded.error}`);
  const payment = decoded.value;

  const refused = refusal(options, route, payment);
  if (refused) return paymentRequired(options, route, `payment rejected: ${refused}`);

  const hold = await options.gateway.settle(payment, payment.accepted);
  if (!hold.success) {
    return paymentRequired(options, route, `payment rejected: ${hold.errorReason ?? "settlement failed"}`);
  }

  const { goalId, seq } = splitPaymentSalt(payment.payload.salt);
  const claim = await options.gateway.claim(goalId, seq, payment);
  if (!claim.ok) {
    // The hold stands and nothing is lost. A 5xx lets the buyer's client retry with the
    // same payment: settle reports it as already held, and the claim is tried again.
    return { status: 502, headers: JSON_HEADERS, body: { error: `could not claim the held payment: ${claim.reason}` } };
  }

  const settlement: SettleResponse = {
    ...hold,
    ...(claim.transaction ? { claimTransaction: claim.transaction } : {}),
  };
  return {
    status: 200,
    headers: { ...JSON_HEADERS, [HEADER_PAYMENT_RESPONSE_V2]: encodeSettlementHeader(settlement) },
    body: {},
    paid: true,
  };
}
