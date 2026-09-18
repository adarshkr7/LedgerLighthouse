/**
 * x402 **v1** resource server renting GPU time by the prepaid job.
 *
 *   GET /resource/gpu?sku=<name>&minutes=<15|30|60>&workload=<name>
 *
 * Phase 1 of `docs/GPU_RENTAL_PLAN.md`: one request buys one bounded job. The
 * buyer names a card, a duration and a workload; the vendor quotes a fixed
 * price from the SKU table, runs it, returns what it measured, and settles.
 * Nothing is stateful, nothing is renewable, and no credential leaves here —
 * all three arrive in phase 2 along with the lease.
 *
 * Pure request/response logic, transport-free so tests can drive it directly.
 * `server.ts` wraps it in node:http.
 *
 * ## The order of operations is the security design
 *
 * Carried over from `services/vendor-search/src/handler.ts` unchanged, because
 * the argument does not depend on what is being sold. Every step that costs
 * something is guarded by a step that costs nothing, cheapest first:
 *
 *   1. shape, SKU, duration and workload validation   free
 *   2. spend ceiling                                  free
 *   3. local payload sanity (payee, amount)           free
 *   4. facilitator `/verify`                          free, no money moves
 *   5. provision and run the job                      COSTS US
 *   6. facilitator `/settle`                          moves the buyer's USDC
 *
 * What changes is the size of step 5. For search it is one sub-cent call and a
 * few seconds. Here it is a machine, allocated from the moment provisioning
 * starts and billing until the job ends, which is why plan §5.4 treats the
 * window between step 5 and step 6 as the exposure worth measuring: on a
 * settlement failure the vendor has already paid for the block.
 *
 * ## Why the job still precedes settlement
 *
 * §5.4 keeps the ordering and says why. Settling first would put the buyer's
 * money at risk instead of ours: if provisioning then failed, the USDC has
 * moved and there is no machine, and the only channel back through `X402Client`
 * is a second 402 that `payment-loop.ts` renders as "the resource server
 * refused the payment" — a sentence that would be false in exactly the case
 * where precision matters.
 *
 * Running first fails closed: no job, no settlement, no money moved, and a 502
 * that reports honestly. The exposure is bounded by provisioning plus runtime
 * plus one settlement round trip, and step 4 is what keeps that from being a
 * griefing vector. It is also the thing to shrink: a shorter block is a smaller
 * window, which is one more reason the vocabulary in `GPU_BLOCK_MINUTES` starts
 * where it does.
 *
 * ## Retries
 *
 * `X402Client` retries 5xx with backoff, so a duplicate request is ordinary.
 * Plan §5.2 is the durable answer and it is phase 2: a store keyed on the
 * vault's spend nonce, which is deterministic across a byte-identical retry.
 * What stands in today is step 4 — a facilitator declines an authorization
 * whose nonce has already been consumed, so the second attempt is refused
 * before it provisions anything. That is a check and not a lock, and the gap
 * between those two words is the reason §5.2 stays open.
 */

import {
  GPU_SKUS,
  HEADER_PAYMENT,
  HEADER_PAYMENT_RESPONSE,
  NETWORK_BASE_SEPOLIA,
  SCHEME_EXACT,
  X402_VERSION,
  assumedCostAtomic,
  decodePaymentHeader,
  encodeSettlementHeader,
  formatUsdc,
  quoteAtomic,
  type Address,
  type PaymentPayload,
  type SettleResponse,
} from "@ntux402/shared";
import type { SpendLedger } from "@ntux402/shared/node";

import type { PaymentGateway } from "./gateway.js";
import type { GpuProvider } from "./providers/index.js";
import { validateMinutes, validateSku, validateWorkload } from "./request.js";

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
  readonly provider: GpuProvider;
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

/**
 * How long the buyer's client should wait before giving up.
 *
 * Provisioning plus the block plus margin, not the block alone. A timeout
 * shorter than the thing being bought would have the client abandon a job it
 * has already committed to pay for, and the vendor would run it anyway.
 */
function timeoutSecondsFor(minutes: number): number {
  return minutes * 60 + 300;
}

export async function handleRequest(
  req: VendorRequest,
  options: HandlerOptions,
): Promise<VendorResponse> {
  const network = options.network ?? NETWORK_BASE_SEPOLIA;
  const baseUrl = options.baseUrl ?? "https://vendor-gpu.local";

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
        provider: options.provider.name,
        spentAtomic: options.ledger?.spentAtomic,
        capAtomic: options.ledger?.capAtomic,
      },
    };
  }

  /**
   * The price list, unpaid.
   *
   * A buyer deciding whether to rent needs the prices before it commits to a
   * 402, and a 402 is a poor way to publish a catalog: it names one price for
   * one request. This route names all of them and moves no money.
   */
  if (rawPath === "/catalog") {
    return {
      status: 200,
      headers: JSON_HEADERS,
      body: {
        skus: Object.values(GPU_SKUS).map((sku) => ({
          name: sku.name,
          label: sku.label,
          vramGb: sku.vramGb,
          pricePerMinuteAtomic: sku.pricePerMinuteAtomic,
          blurb: sku.blurb,
        })),
      },
    };
  }

  if (rawPath !== "/resource/gpu") {
    return { status: 404, headers: JSON_HEADERS, body: { error: "not found" } };
  }

  // --- 1. validation, before anything is quoted or spent --------------------
  const params = new URLSearchParams(rawQuery);

  const skuResult = validateSku(params.get("sku") ?? undefined);
  if (!skuResult.ok) {
    // A malformed request is a 400, never a 402. Answering "payment required"
    // to a request we would refuse for free invites a caller to pay for it.
    return { status: 400, headers: JSON_HEADERS, body: { error: skuResult.error } };
  }
  const sku = skuResult.value;

  const minutesResult = validateMinutes(params.get("minutes") ?? undefined);
  if (!minutesResult.ok) {
    return { status: 400, headers: JSON_HEADERS, body: { error: minutesResult.error } };
  }
  const minutes = minutesResult.value;

  const workloadResult = validateWorkload(params.get("workload") ?? undefined);
  if (!workloadResult.ok) {
    return { status: 400, headers: JSON_HEADERS, body: { error: workloadResult.error } };
  }
  const workload = workloadResult.value;

  /*
   * `resource` carries the whole request, the way the search vendor's carries
   * the query: three different rentals are three different things being bought,
   * and this string is what the vault freezes into `termsHash`. It has to be
   * byte-identical between this 402 and the paid retry, which it is — both are
   * derived from the same request line, and validation rejects rather than
   * repairs so nothing can rewrite it in between.
   */
  const resource = new URL(`${rawPath}?${params.toString()}`, baseUrl).toString();

  const priceAtomic = quoteAtomic(sku, minutes);

  const requirements = {
    scheme: SCHEME_EXACT,
    network,
    asset: options.asset,
    payTo: options.payTo,
    maxAmountRequired: priceAtomic,
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
          /*
           * Says what the buyer gets, and says nothing about the settlement
           * network. The network is already in the typed terms above, and
           * repeating it in prose put it in front of a model twice — which was
           * the difference between weighing a resource and declining it as a
           * testnet toy. Same false inference, cut off at the source.
           *
           * It also states the duration in words. A model reading `minutes=60`
           * out of a URL and a price out of a field has to multiply to notice
           * it is being asked for an hour, and the whole argument here is about
           * what an agent notices before it spends.
           */
          description:
            `${sku.label} for ${minutes} minutes — ` +
            `${workload.label.toLowerCase()}. Billed once, up front, at a fixed price.`,
          mimeType: "application/json",
          maxTimeoutSeconds: timeoutSecondsFor(minutes),
          // A claim about the token, echoed by real facilitators. The client
          // checks it against on-chain truth rather than believing it.
          extra: { name: "USDC", version: "2" },
        },
      ],
      error,
    },
  });

  // --- 2. spend ceiling, before we offer a price we cannot honour -----------
  if (options.ledger?.wouldExceed(priceAtomic)) {
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

  // --- 5. the machine that costs us money ----------------------------------
  const job = await options.provider.runJob({
    sku,
    minutes,
    workload,
    // Plan §5.2: the vault derives this deterministically, so a byte-identical
    // retry carries the same value. Passed through for providers that dedupe
    // on one; nothing here stores it, which is what phase 2 changes.
    idempotencyKey: payment.payload.authorization.nonce,
  });

  if (!job.ok) {
    /*
     * Not a 402. Nothing is wrong with the payment — it verified a moment ago —
     * and saying "payment required" would send the buyer off to diagnose a
     * settlement problem that does not exist. A 502 says what happened: the
     * thing we resell did not run. Nothing was settled.
     *
     * `provisioned` rides along because it is the difference between a refusal
     * that cost nothing and one that allocated a card before it failed. The
     * buyer does not pay either way; the operator needs to know which it was.
     */
    return {
      status: 502,
      headers: JSON_HEADERS,
      body: {
        error: "gpu job failed; no payment was settled",
        providerStatus: job.status,
        provisioned: job.provisioned,
        detail: job.error,
      },
    };
  }

  options.ledger?.record(job.reportedCostAtomic, priceAtomic);

  // --- 6. settle ------------------------------------------------------------
  const settlement: SettleResponse = options.gateway
    ? await options.gateway.settle(payment, requirements)
    : stubSettlement(payment, requirements);

  if (!settlement.success) {
    /*
     * The §5.4 window closing badly. The job ran, the card was billed, and the
     * buyer's USDC did not move — so the vendor is out a block of GPU time and
     * the response has to say so rather than pretending the rental happened.
     *
     * A 402 is right here despite the work being done: the payment genuinely
     * was refused, `X402Client` treats it as such, and the alternative is
     * handing back a 200 whose body describes a rental nobody paid for.
     */
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
      capability: "gpu-job",
      sku: sku.name,
      minutes,
      workload: workload.name,
      job: {
        id: job.jobId,
        provider: job.provider,
        // Carried into the buyer's hands and into the trace. A run record that
        // cannot be told apart from a real rental is one nobody should trust.
        simulated: job.simulated,
        provisionMs: job.provisionMs,
        runMs: job.runMs,
        metrics: job.metrics,
      },
      /*
       * What it cost us against what we charged, reported rather than hidden —
       * the search vendor's habit, kept. `assumedAtomic` is the honest name for
       * this column until the phase 4 measurement replaces it: the quote is a
       * real price and the cost beside it is a guess, so `marginAtomic` is a
       * guess too and reads as one.
       */
      pricing: {
        quotedAtomic: priceAtomic,
        quotedUsd: formatUsdc(BigInt(priceAtomic)),
        assumedAtomic: assumedCostAtomic(sku, minutes),
        reportedCostAtomic: job.reportedCostAtomic,
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
 * Note what stub mode does *not* stub: the provider still runs the job. Against
 * the simulated adapter that costs nothing, and against a real one it costs a
 * block of GPU time — so "no USDC moves" will stop meaning "nothing is spent"
 * the moment plan §8 question 1 is answered.
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
