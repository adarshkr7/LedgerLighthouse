/**
 * The resource server's view of a facilitator: an HTTP client for `/verify` and
 * `/settle`.
 *
 * A near-twin of `mock-api/src/gateway.ts`, deliberately not shared with it.
 * The duplication is about forty lines of `fetch` with no invariant to protect
 * — unlike the price catalog, where two copies would eventually quote two
 * different numbers. What this file gains by standing alone is that a service
 * holding a money-spending API key does not import from a demo fixture server.
 *
 * It also carries `verify`, which mock-api never needed. See `handler.ts` for
 * why the shim cannot do without it.
 */

import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@ntux402/shared";

/** What the handler needs from a facilitator. Narrow, so tests can stand in. */
export interface PaymentGateway {
  verify(payment: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export class HttpFacilitatorGateway implements PaymentGateway {
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, fetchImpl: typeof fetch = globalThis.fetch) {
    this.#url = url.replace(/\/$/, "");
    this.#fetch = fetchImpl;
  }

  async verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    try {
      const response = await this.#fetch(`${this.#url}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentPayload: payment, paymentRequirements: requirements }),
      });
      return (await response.json()) as VerifyResponse;
    } catch (e) {
      // A facilitator we cannot reach is an authorization we cannot trust.
      // Failing closed here costs a search; failing open costs the search *and*
      // the money we spent fetching it.
      return {
        isValid: false,
        invalidReason: `facilitator unreachable: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async settle(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentPayload: payment, paymentRequirements: requirements }),
      });
    } catch (e) {
      return {
        success: false,
        errorReason: `facilitator unreachable: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    try {
      return (await response.json()) as SettleResponse;
    } catch {
      return { success: false, errorReason: `facilitator returned non-JSON (${response.status})` };
    }
  }
}
