/**
 * x402 **v1** resource server fronting AIsa's live search.
 *
 *   GET /resource/aisa/search?q=<urlencoded>&tier=basic|deep
 *
 * Pure request/response logic, transport-free so tests can drive it directly.
 * `server.ts` wraps it in node:http.
 *
 * ## The order of operations is the security design
 *
 * Every step that costs something is guarded by a step that costs nothing, and
 * they run cheapest-first:
 *
 *   1. shape, tier and query validation      free
 *   2. spend ceiling                         free
 *   3. local payload sanity (payee, amount)  free
 *   4. facilitator `/verify`                 free, no money moves
 *   5. upstream AIsa call                    COSTS US
 *   6. facilitator `/settle`                 moves the buyer's USDC
 *
 * Step 4 is the one that is easy to leave out and expensive to omit. Without
 * it, anyone can send a well-formed authorization that will fail at settlement
 * — an already-consumed nonce, an unfunded payer — and we will have paid AIsa
 * for a search before finding out. Repeat that in a loop and the vendor's
 * balance is drained by someone who never spends a cent. `/verify` exists in
 * the x402 protocol precisely so a resource server can ask "would this pay?"
 * before doing the work, and this is what it is for.
 *
 * ## Why the upstream call precedes settlement
 *
 * The reverse order leaves the worst failure unreportable. If settlement
 * succeeds and the upstream call then fails, the buyer's USDC has moved and
 * there is no data — and the only channel back through `X402Client` is a second
 * 402, which `payment-loop.ts` renders as "the resource server refused the
 * payment". That sentence would be false in exactly the case where precision
 * matters most.
 *
 * Fetching first fails closed: no data, no settlement, no money moved, and a
 * 502 that `describeFailure` reports honestly as `HTTP 502`. The cost is one
 * wasted sub-cent call, and step 4 keeps that from being a griefing vector.
 */

import {
  COST_HEADER_CUSTOMER,
  HEADER_PAYMENT,
  HEADER_PAYMENT_RESPONSE,
  NETWORK_BASE_SEPOLIA,
  SCHEME_EXACT,
  X402_VERSION,
  decodePaymentHeader,
  encodeSettlementHeader,
  type Address,
  type PaymentPayload,
  type SearchTier,
  type SettleResponse,
} from "@ntux402/shared";

import type { PaymentGateway } from "./gateway.js";
import { validateQuery, validateTier } from "./query.js";
import type { SpendLedger, UpstreamSearch } from "./upstream.js";

export interface VendorRequest {
  readonly method: string;
  /** Path including any query string. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface VendorResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface HandlerOptions {
  readonly upstream: UpstreamSearch;
  /** Where real USDC lands. An address the operator controls and can sweep. */
  readonly payTo: Address;
  readonly asset: Address;
  readonly network?: string;
  /** Absolute base used to build the `resource` field. */
  readonly baseUrl?: string;
  /** Omit for stub mode: payloads are checked, but no USDC moves. */
  readonly gateway?: PaymentGateway;
  readonly ledger?: SpendLedger;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;
const MAX_TIMEOUT_SECONDS = 60;

export async function handleRequest(
  req: VendorRequest,
  options: HandlerOptions,
): Promise<VendorResponse> {
  const network = options.network ?? NETWORK_BASE_SEPOLIA;
  const baseUrl = options.baseUrl ?? "https://vendor-aisa.local";

  if (req.method !== "GET") {
    return { status: 405, headers: JSON_HEADERS, body: { error: "method not allowed" } };
  }

  const [rawPath = "/", rawQuery = ""] = req.path.split("?");

  if (rawPath === "/health") {
    return {
      status: 200,
      headers: JSON_HEADERS,
      body: {
        ok: true,
        x402Version: X402_VERSION,
        settlement: options.gateway ? "live" : "stub",
        spentAtomic: options.ledger?.spentAtomic,
        capAtomic: options.ledger?.capAtomic,
      },
    };
  }

  if (rawPath !== "/resource/aisa/search") {
    return { status: 404, headers: JSON_HEADERS, body: { error: "not found" } };
  }

  // --- 1. validation, before anything is quoted or spent --------------------
  const params = new URLSearchParams(rawQuery);

  const tierResult = validateTier(params.get("tier") ?? undefined);
  if (!tierResult.ok) {
    return { status: 400, headers: JSON_HEADERS, body: { error: tierResult.error } };
  }
  const tier = tierResult.value;

  const queryResult = validateQuery(params.get("q") ?? undefined);
  if (!queryResult.ok) {
    // A malformed request is a 400, never a 402. Answering "payment required"
    // to a request we would refuse for free invites a caller to pay for it.
    return { status: 400, headers: JSON_HEADERS, body: { error: queryResult.error } };
  }
  const query = queryResult.value;

  /*
   * `resource` carries the query, unlike the mock vendor which strips its query
   * string off. Here the query *is* the resource identity — two different
   * searches are two different things being bought — and it is what the vault
   * freezes into `termsHash`. It has to be byte-identical between this 402 and
   * the paid retry, which it is: both are derived from the same request line.
   */
  const resource = new URL(`${rawPath}?${params.toString()}`, baseUrl).toString();

  const requirements = {
    scheme: SCHEME_EXACT,
    network,
    asset: options.asset,
    payTo: options.payTo,
    maxAmountRequired: tier.priceAtomic,
    resource,
  } as const;

  const paymentRequired = (error: string): VendorResponse => ({
    status: 402,
    headers: JSON_HEADERS,
    body: {
      x402Version: X402_VERSION,
      accepts: [
        {
          ...requirements,
          // Says what the buyer gets, not where the payment lands. The network
          // is already in the typed terms above; repeating it here put it in
          // the *prose* channel too, and a model reading it twice was the
          // difference between weighing the resource and declining it as a
          // testnet toy. See the settlement-network note in the agent's system
          // prompt — this is the same false inference, cut off at its source.
          description:
            `Live web search via AIsa — ${tier.label}. Returns current results from a ` +
            `production search API, priced per call.`,
          mimeType: "application/json",
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          // A claim about the token, echoed by real facilitators. The client
          // checks it against on-chain truth rather than believing it.
          extra: { name: "USDC", version: "2" },
        },
      ],
      error,
    },
  });

  // --- 2. spend ceiling, before we offer a price we cannot honour -----------
  if (options.ledger?.wouldExceed(tier.priceAtomic)) {
    // 429 rather than 503: the x402 client retries 5xx with backoff and treats
    // any other 4xx as final. A ceiling breach is final — retrying it is how a
    // bounded overspend becomes an unbounded one.
    return {
      status: 429,
      headers: JSON_HEADERS,
      body: {
        error: "vendor spend ceiling reached",
        spentAtomic: options.ledger.spentAtomic,
        capAtomic: options.ledger.capAtomic,
      },
    };
  }

  const header = req.headers[HEADER_PAYMENT] ?? req.headers[HEADER_PAYMENT.toLowerCase()];
  if (header === undefined || header === "") {
    return paymentRequired("payment required");
  }

  const decoded = decodePaymentHeader(header);
  if (!decoded.ok) return paymentRequired(`payment rejected: ${decoded.error}`);
  const payment = decoded.value;

  // --- 3. local sanity: free, and catches the obvious ----------------------
  const local = checkLocally(payment, requirements);
  if (local) return paymentRequired(`payment rejected: ${local}`);

  // --- 4. would this actually pay? -----------------------------------------
  if (options.gateway) {
    const verified = await options.gateway.verify(payment, requirements);
    if (!verified.isValid) {
      return paymentRequired(
        `payment rejected: ${verified.invalidReason ?? "facilitator declined to verify"}`,
      );
    }
  }

  // --- 5. the call that costs us money -------------------------------------
  const upstream = await options.upstream.search(query, tier);
  if (!upstream.ok) {
    /*
     * Deliberately not a 402. Nothing is wrong with the payment — it verified a
     * moment ago — and saying "payment required" here would send the buyer off
     * to diagnose a settlement problem that does not exist. A 502 says what
     * happened: the thing we resell is unavailable. Nothing was settled.
     */
    return {
      status: 502,
      headers: JSON_HEADERS,
      body: {
        error: "upstream search failed; no payment was settled",
        upstreamStatus: upstream.status,
        detail: upstream.error,
      },
    };
  }

  options.ledger?.record(upstream.costAtomic, tier.priceAtomic);

  // --- 6. settle ------------------------------------------------------------
  const settlement: SettleResponse = options.gateway
    ? await options.gateway.settle(payment, requirements)
    : stubSettlement(payment, requirements);

  if (!settlement.success) {
    return paymentRequired(`payment rejected: ${settlement.errorReason ?? "settlement failed"}`);
  }

  return {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      [HEADER_PAYMENT_RESPONSE]: encodeSettlementHeader(settlement),
    },
    body: {
      resource,
      capability: "search",
      tier: tier.name,
      query,
      data: upstream.body,
      /*
       * What it cost us against what we charged, reported rather than hidden.
       * The trace wants both (docs/AISA_LIVE_SEARCH.md §8) and a vendor that
       * publishes its own margin is a better demo than one that does not.
       * `costAtomic` is undefined when AIsa omitted the header.
       */
      upstream: {
        requestId: upstream.requestId,
        latencyMs: upstream.latencyMs,
        costAtomic: upstream.costAtomic,
        quotedAtomic: tier.priceAtomic,
        costHeader: COST_HEADER_CUSTOMER,
      },
    },
  };
}

/**
 * The two things that need no chain and no facilitator.
 *
 * Returns a reason string when the payload is unusable, or undefined when it is
 * worth asking the facilitator about. Cheap by design: this runs before
 * `/verify` so that the clearly-wrong never costs a round trip.
 */
function checkLocally(
  payment: PaymentPayload,
  requirements: { payTo: string; maxAmountRequired: string; network: string },
): string | undefined {
  if (payment.network !== requirements.network) {
    return `network mismatch: expected ${requirements.network}, got ${payment.network}`;
  }
  const auth = payment.payload.authorization;
  if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return `payee mismatch: expected ${requirements.payTo}`;
  }
  if (BigInt(auth.value) < BigInt(requirements.maxAmountRequired)) {
    return `insufficient: ${auth.value} < ${requirements.maxAmountRequired}`;
  }
  return undefined;
}

/**
 * No facilitator wired in. Marks itself as a stub, because a demo that reports
 * success without moving money is worse than one that fails loudly.
 *
 * Note what stub mode does *not* stub: the upstream call still happens and
 * still costs real credits. "No USDC moves" is not "nothing is spent".
 */
function stubSettlement(
  payment: PaymentPayload,
  requirements: { network: string },
): SettleResponse {
  return {
    success: true,
    simulated: true,
    network: requirements.network,
    payer: payment.payload.authorization.from,
  };
}
