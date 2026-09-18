/**
 * A rate limit on the enclave's own key operations.
 *
 * ## Why the HTTP limiter is not this
 *
 * `http.ts` already rate limits `/payer`, `/authorizations` and `/sweeps`, and
 * that limiter is per-IP (`clientKey`). Per-IP is the right key on a laptop and
 * very nearly a no-op on the deployed enclave, for a reason worth stating
 * plainly rather than discovering later:
 *
 * The ROFL machine publishes the signer through the Oasis proxy — the
 * `https://p8402.m<id>.<cluster>.rofl.app` address in `.env.example` — and the
 * container binds `0.0.0.0` behind a `ports:` mapping. By the time a request
 * reaches `req.socket.remoteAddress`, the source address is the proxy's or the
 * bridge gateway's, not the caller's. Every caller in the world therefore lands
 * in **one** bucket, and the per-IP limiter degrades into a global limiter that
 * nobody chose the size of. `TRUST_PROXY=true` swaps one failure for another:
 * `x-forwarded-for` is caller-supplied, so the buckets become per-*claim* and a
 * flood rotates through them for free.
 *
 * Neither setting bounds the thing that actually costs the enclave something.
 *
 * ## What this bounds
 *
 * `rofl-appd`, over the UNIX socket in `keystore.ts`. Two paths reach it:
 *
 *   - `mint()`   — one `keys/generate` plus a rewrite of the persistent index.
 *   - `signerFor()` — one `keys/generate` **per signature**, because
 *     `RoflKeyStore` deliberately re-derives rather than caching key material.
 *
 * That daemon is a single shared resource inside the TEE, serving every request
 * this process makes regardless of which route, which IP or which proxy hop
 * produced it. So the limit lives here, under all of them, and is global by
 * design: one bucket per operation, no caller identity, because at this layer
 * there is none to be had and the resource being protected is singular anyway.
 *
 * It composes with the HTTP limiter rather than replacing it. The edge limiter
 * sheds obvious floods cheaply and before any body is read; this one is the
 * floor that holds when the edge limiter cannot tell callers apart.
 *
 * ## Deliberate non-goals
 *
 * **Not fair queuing.** A global bucket means a loop can starve a legitimate
 * caller of its share within a window. Fixing that needs caller identity, which
 * is the thing the deployment does not give us; a shared bucket that holds is
 * better than a per-caller bucket keyed on something forgeable.
 *
 * **Not a concurrency gate.** A fixed window admits its whole allowance at once,
 * so a burst can put `max` socket round trips in flight together. Capping
 * in-flight derivations too would be a real improvement and a behavioural change
 * for legitimate parallel goals, so it is left out rather than guessed at.
 *
 * **Not a lifetime cap on minted keys.** Rate-limiting mints slows the growth of
 * `payers.json`; it never stops it. That was the existing decision in `http.ts`
 * and this does not revisit it.
 */

import { RateLimiter } from "@ntux402/shared/node";
import type { Address, LocalAccount } from "viem";

import type { KeyStore } from "./keystore.js";

/** The two things a caller can make the enclave do. */
export type EnclaveOperation = "mint" | "derive";

/**
 * Thrown instead of returned, unlike every refusal in `service.ts`.
 *
 * `KeyStore` is an interface `AuthorizationSigner` shares with three
 * implementations, and widening its return types to carry a limiter outcome
 * would push this concern into `sign()` and `sweep()` — the two functions whose
 * whole value is that every branch in them is a payment-safety check. Throwing
 * keeps the limit out of the specification and lands it in the one place
 * `http.ts` already handles failures.
 */
export class EnclaveRateLimitError extends Error {
  readonly operation: EnclaveOperation;
  /** Seconds until the window resets. Goes straight into `retry-after`. */
  readonly retryAfterSeconds: number;

  constructor(operation: EnclaveOperation, retryAfterSeconds: number, perMinute: number) {
    super(
      `rate limit exceeded: the enclave is capped at ${perMinute} ${operation} ` +
        `operation(s) per minute. Retry in ${retryAfterSeconds}s.`,
    );
    this.name = "EnclaveRateLimitError";
    this.operation = operation;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface EnclaveLimits {
  /** `POST /payer` — a fresh key and an index write. */
  readonly mintPerMinute: number;
  /** Every signature — one re-derivation of an existing key. */
  readonly derivePerMinute: number;
}

/**
 * Generous on purpose. The job is to stop a runaway loop from pinning the key
 * daemon, not to shape traffic: a demo run mints once per goal and derives once
 * per paid call, so a real session sits two orders of magnitude below these.
 *
 * `derive` is the higher of the two because it is the per-signature path and
 * the cheaper one — no index write, no new key.
 */
export const DEFAULT_ENCLAVE_LIMITS: EnclaveLimits = {
  mintPerMinute: 30,
  derivePerMinute: 240,
};

/** Fixed. Configuring the window as well buys nothing and doubles the settings. */
const WINDOW_MS = 60_000;

/**
 * One bucket per operation. The key is a constant because the limit is global —
 * see the header. Named rather than `""` so a log or a debugger reads sensibly.
 */
const GLOBAL = "enclave";

function perMinute(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  /*
   * Rejected rather than coerced, and rejected at startup rather than at the
   * first request. `Number("")` is 0 and `Number("30/min")` is NaN; silently
   * reading either as "unlimited" or as "refuse everything" would be a limiter
   * whose posture nobody could read off the config. A typo should stop the boot
   * of the process holding the keys, not change what it enforces.
   */
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive integer (requests per minute); got ${JSON.stringify(raw)}. ` +
        `Leave it unset for the default of ${fallback}.`,
    );
  }
  return value;
}

export function enclaveLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): EnclaveLimits {
  return {
    mintPerMinute: perMinute(env, "SIGNER_ENCLAVE_MINT_PER_MIN", DEFAULT_ENCLAVE_LIMITS.mintPerMinute),
    derivePerMinute: perMinute(
      env,
      "SIGNER_ENCLAVE_DERIVE_PER_MIN",
      DEFAULT_ENCLAVE_LIMITS.derivePerMinute,
    ),
  };
}

/** One line for the startup banner, in the style of `describeGuard()`. */
export function describeEnclaveLimits(limits: EnclaveLimits): string {
  return `mint ${limits.mintPerMinute}/min · derive ${limits.derivePerMinute}/min (global)`;
}

/**
 * Wraps any `KeyStore` so both enclave-touching methods are rate limited.
 *
 * A decorator rather than a change inside `RoflKeyStore` for two reasons. The
 * limit applies to `FileKeyStore` and `InMemoryKeyStore` too — they are slower
 * per call, not faster, and the file store rewrites the whole key file on every
 * mint. And keeping `RoflKeyStore` a plain adapter over `rofl-appd` means the
 * enclave-custody argument in `keystore.ts` is still readable in one file.
 */
export class RateLimitedKeyStore implements KeyStore {
  readonly #inner: KeyStore;
  readonly #limits: EnclaveLimits;
  readonly #mint: RateLimiter;
  readonly #derive: RateLimiter;

  constructor(inner: KeyStore, limits: EnclaveLimits = DEFAULT_ENCLAVE_LIMITS) {
    this.#inner = inner;
    this.#limits = limits;
    this.#mint = new RateLimiter({ windowMs: WINDOW_MS, max: limits.mintPerMinute });
    this.#derive = new RateLimiter({ windowMs: WINDOW_MS, max: limits.derivePerMinute });
  }

  #check(limiter: RateLimiter, operation: EnclaveOperation, max: number): void {
    if (limiter.allow(GLOBAL)) return;
    throw new EnclaveRateLimitError(operation, limiter.retryAfterSeconds(GLOBAL), max);
  }

  async mint(): Promise<Address> {
    this.#check(this.#mint, "mint", this.#limits.mintPerMinute);
    return this.#inner.mint();
  }

  /**
   * Charged before the lookup, not after a hit.
   *
   * `RoflKeyStore.signerFor` returns `undefined` without touching the socket
   * when it holds no key for the address, so charging only on a hit would be
   * the tighter accounting of enclave calls. It is not what we want: the
   * budget being defended is the daemon's throughput for *legitimate* signing,
   * and a caller that can probe unknown addresses for free is a caller that can
   * measure the store. Reaching this line at all already costs an approved,
   * finalized spend record on chain (`service.ts`), so misses are rare and the
   * conservative charge is close to free.
   */
  async signerFor(address: Address): Promise<LocalAccount | undefined> {
    this.#check(this.#derive, "derive", this.#limits.derivePerMinute);
    return this.#inner.signerFor(address);
  }

  /** Reads the in-process index only — no enclave call, so nothing to limit. */
  async addresses(): Promise<readonly Address[]> {
    return this.#inner.addresses();
  }
}
