/**
 * The resource server's view of a facilitator: an HTTP client for `POST /settle`.
 *
 * Deliberately thin. The resource server does not verify signatures, read the
 * chain, or hold a key — it asks whether it got paid and serves the data if so.
 * That is the division of labour x402 assumes, and keeping it means this file
 * has nothing security-relevant in it beyond "believe the facilitator you chose".
 */

import type {
  PaymentGateway,
} from "./handler.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from "@ntux402/shared";

export class HttpFacilitatorGateway implements PaymentGateway {
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, fetchImpl: typeof fetch = globalThis.fetch) {
    this.#url = url.replace(/\/$/, "");
    this.#fetch = fetchImpl;
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
      // A facilitator we cannot reach is a payment we cannot confirm. Serving
      // the data anyway would be giving it away.
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
