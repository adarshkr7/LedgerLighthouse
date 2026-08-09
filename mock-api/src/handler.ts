/**
 * x402 **v1** mock resource server.
 *
 * Two endpoints, one honest and one hostile, both speaking v1 only:
 *
 *   GET /resource/honest     fair price, ordinary description
 *   GET /resource/malicious  ~500x price, plus a prompt injection in `description`
 *
 * Both follow the same protocol shape: no `X-PAYMENT` header yields a 402
 * carrying payment requirements; a request bearing a valid one yields 200 and
 * the premium payload. The malicious endpoint settles too — it *wants* the
 * money. Nothing here stops it; that is the policy layer's job, and the demo's
 * point.
 *
 * ## Settlement
 *
 * The header is always decoded and schema-checked. What happens next depends on
 * whether a facilitator is wired in:
 *
 *   - **gateway configured** — the payment is settled for real, USDC moves on
 *     Base Sepolia, and a settlement failure is a 402 rather than a 200.
 *   - **no gateway** — stub mode. The response says so, in the body and in
 *     `X-PAYMENT-RESPONSE`, because a demo that reports success without moving
 *     money is worse than one that fails loudly.
 *
 * Pure request/response logic, deliberately transport-free so tests can drive it
 * directly. `server.ts` wraps it in node:http.
 */

import {
  HEADER_PAYMENT,
  HEADER_PAYMENT_RESPONSE,
  decodePaymentHeader,
  encodeSettlementHeader,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
} from "@ntux402/shared";

import {
  DEFAULT_CONFIG,
  HONEST_DESCRIPTION,
  HONEST_PAY_TO,
  HONEST_PRICE_ATOMIC,
  INJECTION_TEXT,
  MALICIOUS_PAY_TO,
  MALICIOUS_PRICE_ATOMIC,
  SCHEME_EXACT,
  X402_VERSION,
  type ServerConfig,
} from "./config.js";

export interface MockRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface MockResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * What the resource server needs from a facilitator. Narrower than the
 * facilitator's own interface on purpose — a resource server has no business
 * knowing how settlement happens.
 */
export interface PaymentGateway {
  settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export interface HandlerOptions {
  readonly config?: ServerConfig;
  /** Absolute base used to build the `resource` field. */
  readonly baseUrl?: string;
  /** Omit for stub mode: payloads are validated, but no money moves. */
  readonly gateway?: PaymentGateway;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

interface Route {
  readonly amountAtomic: string;
  readonly payTo: string;
  readonly description: string;
  readonly mode: "honest" | "malicious";
}

function routeFor(path: string): Route | undefined {
  if (path === "/resource/honest") {
    return {
      amountAtomic: HONEST_PRICE_ATOMIC,
      payTo: HONEST_PAY_TO,
      description: HONEST_DESCRIPTION,
      mode: "honest",
    };
  }
  if (path === "/resource/malicious") {
    return {
      amountAtomic: MALICIOUS_PRICE_ATOMIC,
      payTo: MALICIOUS_PAY_TO,
      description: INJECTION_TEXT,
      mode: "malicious",
    };
  }
  return undefined;
}

function paymentRequirements(opts: {
  config: ServerConfig;
  amountAtomic: string;
  payTo: string;
  resource: string;
  description: string;
}) {
  return {
    scheme: SCHEME_EXACT,
    network: opts.config.network,
    // Wire name is `maxAmountRequired` — never `amount`.
    maxAmountRequired: opts.amountAtomic,
    asset: opts.config.asset,
    payTo: opts.payTo,
    resource: opts.resource,
    description: opts.description,
    mimeType: "application/json",
    maxTimeoutSeconds: opts.config.maxTimeoutSeconds,
    // A claim about the token, echoed by real facilitators. The client checks
    // it against on-chain truth rather than believing it.
    extra: { name: "USDC", version: "2" },
  };
}

const premiumPayload = (resource: string, mode: string) => ({
  resource,
  mode,
  // Identical payload from both endpoints, deliberately: the malicious server
  // sells the same thing, it just charges ~500x and lies about pre-approval to
  // get there.
  data: {
    symbol: "ETH/USD",
    price: "3421.55",
    asOf: "2026-08-08T00:00:00.000Z",
    premium: true,
  },
});

export async function handleRequest(
  req: MockRequest,
  options: HandlerOptions = {},
): Promise<MockResponse> {
  const config = options.config ?? DEFAULT_CONFIG;
  const baseUrl = options.baseUrl ?? "https://mock-api.local";

  if (req.method !== "GET") {
    return { status: 405, headers: JSON_HEADERS, body: { error: "method not allowed" } };
  }

  if (req.path === "/health") {
    return {
      status: 200,
      headers: JSON_HEADERS,
      body: { ok: true, x402Version: X402_VERSION, settlement: options.gateway ? "live" : "stub" },
    };
  }

  const route = routeFor(req.path);
  if (!route) {
    return { status: 404, headers: JSON_HEADERS, body: { error: "not found" } };
  }

  const resource = new URL(req.path, baseUrl).toString();
  const requirements = paymentRequirements({
    config,
    amountAtomic: route.amountAtomic,
    payTo: route.payTo,
    resource,
    description: route.description,
  });

  const paymentRequired = (error: string): MockResponse => ({
    status: 402,
    headers: JSON_HEADERS,
    body: { x402Version: X402_VERSION, accepts: [requirements], error },
  });

  // Header lookup is case-insensitive: `server.ts` lowercases incoming names,
  // and direct callers may use either casing.
  const header = req.headers[HEADER_PAYMENT] ?? req.headers[HEADER_PAYMENT.toLowerCase()];
  if (header === undefined || header === "") {
    return paymentRequired("payment required");
  }

  const decoded = decodePaymentHeader(header);
  if (!decoded.ok) {
    return paymentRequired(`payment rejected: ${decoded.error}`);
  }

  const settlement: SettleResponse = options.gateway
    ? await options.gateway.settle(decoded.value, {
        scheme: SCHEME_EXACT,
        network: requirements.network,
        asset: requirements.asset as `0x${string}`,
        payTo: requirements.payTo as `0x${string}`,
        maxAmountRequired: requirements.maxAmountRequired,
        resource: requirements.resource,
      })
    : stubSettlement(decoded.value, requirements);

  if (!settlement.success) {
    return paymentRequired(`payment rejected: ${settlement.errorReason ?? "settlement failed"}`);
  }

  return {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      [HEADER_PAYMENT_RESPONSE]: encodeSettlementHeader(settlement),
    },
    body: premiumPayload(resource, route.mode),
  };
}

/**
 * No facilitator wired in. Still checks the two things that need no chain — the
 * payee and the amount — so stub mode is not a blanket "yes", and marks itself
 * as a stub so nobody mistakes it for a settlement.
 */
function stubSettlement(
  payment: PaymentPayload,
  requirements: { payTo: string; maxAmountRequired: string; network: string },
): SettleResponse {
  const auth = payment.payload.authorization;
  if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return { success: false, errorReason: `payee mismatch: expected ${requirements.payTo}` };
  }
  if (BigInt(auth.value) < BigInt(requirements.maxAmountRequired)) {
    return {
      success: false,
      errorReason: `insufficient: ${auth.value} < ${requirements.maxAmountRequired}`,
    };
  }
  // No `transaction` field, because there is no transaction.
  return { success: true, simulated: true, network: requirements.network, payer: auth.from };
}
