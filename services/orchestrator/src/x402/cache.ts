/**
 * Response cache keyed by request (plan §6.1).
 *
 * Its job is narrow and load-bearing: after a resource has been fetched
 * successfully — including when that success cost money — a repeat request must
 * be served from here rather than going back to the network. Without it, a
 * retry after a network blip re-enters the payment path and pays twice for one
 * resource.
 *
 * Only 200s are cached. A 402 is control flow, not a result, and its terms are
 * per-request; caching one would let stale terms drive a later payment. A 5xx
 * is not a result either.
 */

/** What a caller stores. The timestamp is not theirs to supply — see `ResponseCache.set`. */
export interface CacheableResponse {
  readonly status: 200;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export interface CachedResponse extends CacheableResponse {
  /** Epoch ms, stamped by the cache using its own clock. */
  readonly storedAt: number;
}

export interface ResponseCache {
  get(key: string): CachedResponse | undefined;
  /**
   * Stores an entry, stamping `storedAt` from the cache's own clock.
   *
   * The caller deliberately cannot supply the timestamp: the cache owns TTL
   * semantics, so it must own the clock those semantics are measured against.
   * Letting a caller stamp it means an injected clock silently fails to apply.
   */
  set(key: string, value: CacheableResponse): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
}

export function cacheKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

export interface InMemoryCacheOptions {
  /** Milliseconds an entry stays fresh. Omit for no expiry. */
  readonly ttlMs?: number;
  /** Injectable clock, so TTL is testable without waiting. */
  readonly now?: () => number;
}

export class InMemoryResponseCache implements ResponseCache {
  readonly #entries = new Map<string, CachedResponse>();
  readonly #ttlMs: number | undefined;
  readonly #now: () => number;

  constructor(options: InMemoryCacheOptions = {}) {
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  get(key: string): CachedResponse | undefined {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (this.#ttlMs !== undefined && this.#now() - hit.storedAt > this.#ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return hit;
  }

  set(key: string, value: CacheableResponse): void {
    this.#entries.set(key, { ...value, storedAt: this.#now() });
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
