/**
 * x402 v1 resource client (ARCHITECTURE.md §6).
 *
 * The defining choice here: **402 is control flow, not an error.** It resolves
 * to an ordinary outcome carrying typed terms, exactly like a 200 resolves to
 * data. Nothing throws on the payment path, because a thrown 402 invites a
 * catch-and-retry that quietly becomes a catch-and-pay.
 *
 * Branching:
 *   200   -> cache and return data
 *   402   -> parse strictly; malformed is a rejection, never a coercion
 *   5xx   -> retry with exponential backoff, bounded
 *   other -> fail immediately, no retry
 *
 * This module holds no keys and constructs no authorization. When a payment
 * header is supplied it is passed through opaquely — built elsewhere, by the
 * component that is allowed to build it.
 */

import {
  HEADER_PAYMENT,
  HEADER_PAYMENT_RESPONSE,
  parsePaymentRequired,
  type PaymentRequired,
} from "@ntux402/shared";

import {
  InMemoryResponseCache,
  cacheKey,
  type ResponseCache,
} from "./cache.js";

export type FetchOutcome =
  | {
      readonly kind: "ok";
      readonly status: 200;
      readonly body: unknown;
      readonly headers: Readonly<Record<string, string>>;
      /** True when served from cache — meaning no request left the process. */
      readonly fromCache: boolean;
      /** Present when the resource server reported settlement. */
      readonly paymentResponse: string | undefined;
    }
  | {
      readonly kind: "payment-required";
      readonly status: 402;
      readonly parsed: PaymentRequired;
    }
  | {
      readonly kind: "failed";
      readonly reason: FailureReason;
    };

export type FailureReason =
  | { readonly type: "malformed-402"; readonly error: string }
  | { readonly type: "invalid-json"; readonly error: string }
  | { readonly type: "http-error"; readonly status: number; readonly body: string }
  | { readonly type: "network-error"; readonly error: string }
  | {
      readonly type: "retries-exhausted";
      readonly attempts: number;
      readonly lastStatus: number | undefined;
      readonly lastError: string | undefined;
    };

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 250,
  factor: 2,
};

export interface ClientOptions {
  readonly cache?: ResponseCache;
  readonly retry?: Partial<RetryPolicy>;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable so backoff is exercised without real waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  /**
   * An x402 payment payload, sent as `X-PAYMENT`. Opaque here by design: this
   * service never builds one. A request carrying it bypasses the cache read,
   * since paying implies the caller already knows it has no usable result.
   */
  readonly payment?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Deterministic exponential backoff. No jitter — a single agent isn't a thundering herd. */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  return Math.round(policy.baseDelayMs * policy.factor ** (attempt - 1));
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export class X402Client {
  readonly #cache: ResponseCache;
  readonly #retry: RetryPolicy;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions = {}) {
    this.#cache = options.cache ?? new InMemoryResponseCache();
    this.#retry = { ...DEFAULT_RETRY, ...options.retry };
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get cache(): ResponseCache {
    return this.#cache;
  }

  async fetchResource(url: string, options: RequestOptions = {}): Promise<FetchOutcome> {
    const key = cacheKey("GET", url);

    // A cached 200 short-circuits everything. This is the guard that stops a
    // retry after a network blip from re-entering the payment path.
    if (options.payment === undefined) {
      const cached = this.#cache.get(key);
      if (cached) {
        return {
          kind: "ok",
          status: 200,
          body: cached.body,
          headers: cached.headers,
          fromCache: true,
          paymentResponse: cached.headers[HEADER_PAYMENT_RESPONSE.toLowerCase()],
        };
      }
    }

    let lastStatus: number | undefined;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= this.#retry.maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: "GET",
          headers: options.payment === undefined ? {} : { [HEADER_PAYMENT]: options.payment },
        });
      } catch (e) {
        // Transport failure. Same treatment as a 5xx: retry, bounded.
        lastError = e instanceof Error ? e.message : String(e);
        lastStatus = undefined;
        if (attempt === this.#retry.maxAttempts) {
          return {
            kind: "failed",
            reason: { type: "retries-exhausted", attempts: attempt, lastStatus, lastError },
          };
        }
        await this.#sleep(backoffDelay(attempt, this.#retry));
        continue;
      }

      lastStatus = response.status;
      const headers = headersToObject(response.headers);

      if (response.status === 200) {
        let body: unknown;
        try {
          body = await response.json();
        } catch (e) {
          return {
            kind: "failed",
            reason: { type: "invalid-json", error: e instanceof Error ? e.message : String(e) },
          };
        }
        this.#cache.set(key, { status: 200, body, headers });
        return {
          kind: "ok",
          status: 200,
          body,
          headers,
          fromCache: false,
          paymentResponse: headers[HEADER_PAYMENT_RESPONSE.toLowerCase()],
        };
      }

      if (response.status === 402) {
        let raw: unknown;
        try {
          raw = await response.json();
        } catch (e) {
          return {
            kind: "failed",
            reason: { type: "invalid-json", error: e instanceof Error ? e.message : String(e) },
          };
        }

        const parsed = parsePaymentRequired(raw);
        if (!parsed.ok) {
          // Rejected, not repaired. A 402 we cannot fully understand is not a
          // 402 we may pay against, and retrying would not make it valid.
          return { kind: "failed", reason: { type: "malformed-402", error: parsed.error } };
        }
        return { kind: "payment-required", status: 402, parsed: parsed.value };
      }

      if (response.status >= 500) {
        lastError = await response.text().catch(() => "");
        if (attempt === this.#retry.maxAttempts) {
          return {
            kind: "failed",
            reason: { type: "retries-exhausted", attempts: attempt, lastStatus, lastError },
          };
        }
        await this.#sleep(backoffDelay(attempt, this.#retry));
        continue;
      }

      // Any other 4xx is a definitive answer. Retrying it is just noise.
      return {
        kind: "failed",
        reason: {
          type: "http-error",
          status: response.status,
          body: await response.text().catch(() => ""),
        },
      };
    }

    return {
      kind: "failed",
      reason: {
        type: "retries-exhausted",
        attempts: this.#retry.maxAttempts,
        lastStatus,
        lastError,
      },
    };
  }
}
