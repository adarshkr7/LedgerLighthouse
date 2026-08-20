/**
 * The shared HTTP guard: bind address, origin policy, bearer token, rate limit.
 *
 * Three services expose HTTP and all three previously did the same two things
 * wrong. They called `server.listen(port)`, which binds `0.0.0.0` — every
 * interface, including whatever Wi-Fi the machine is on — while logging
 * `http://127.0.0.1:PORT` and reading as though it were loopback-only. And they
 * sent `access-control-allow-origin: *`.
 *
 * Together that meant anyone on the same network could mint payer keys, start
 * runs against a goal id and burn its confidential budget, or hand the
 * facilitator authorizations to pay gas on. The vault bounds the *loss* — it
 * always did — but griefing was free, and "the loss is bounded" is a poor
 * answer to "why did my demo goal run out of calls mid-pitch".
 *
 * ## The controls, in order of how much they actually do
 *
 *  1. **Bind address.** `BIND_HOST`, default `127.0.0.1`. This is the real
 *     control and it costs nothing: a socket that is not listening on the
 *     network cannot be reached from it. Deploying somewhere that needs a
 *     public bind is an explicit `BIND_HOST=0.0.0.0`, which is then a decision
 *     someone made rather than a default nobody noticed.
 *  2. **Origin allowlist.** Localhost is reflected automatically so the dev UI
 *     works untouched; anything else must be named in `CORS_ORIGINS`. A
 *     disallowed origin simply gets no CORS headers, which is what makes the
 *     browser refuse it.
 *  3. **Bearer token.** `SERVICE_TOKEN`, enforced only when set. Deliberately
 *     opt-in: a token shipped to a browser is not a secret, and pretending
 *     otherwise is worse than not having one. It exists so a publicly bound
 *     deployment is not open to every scanner on the internet.
 *  4. **Rate limit.** Per-IP, in-memory, on the expensive routes. Not a
 *     distributed limiter and not trying to be — it stops a loop, not a
 *     botnet.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Interface to bind. Loopback unless someone deliberately says otherwise. */
export function bindHost(): string {
  return process.env["BIND_HOST"] ?? "127.0.0.1";
}

/** Origins allowed in addition to localhost, from `CORS_ORIGINS`. */
export function allowedOrigins(): readonly string[] {
  const raw = process.env["CORS_ORIGINS"];
  if (!raw) return [];
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");
}

/**
 * True for `http://localhost:*` and `http://127.0.0.1:*` (and the IPv6 form).
 *
 * Parsed with `URL` rather than matched with a regex: `http://localhost.evil.com`
 * passes a naive `startsWith` and is emphatically not localhost.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "http:" && protocol !== "https:") return false;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * CORS headers for one request, or an empty object when the origin is not
 * allowed — the browser then blocks the response, which is the point.
 *
 * `vary: origin` because the answer depends on the request; without it a shared
 * cache can hand one origin's approval to another.
 */
export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return {};

  const permitted = isLoopbackOrigin(origin) || allowedOrigins().includes(origin);
  if (!permitted) return {};

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

/** The configured token, or undefined when the service is running open. */
export function serviceToken(): string | undefined {
  const token = process.env["SERVICE_TOKEN"];
  return token === undefined || token === "" ? undefined : token;
}

/**
 * Constant-time-ish comparison. Not `crypto.timingSafeEqual`, because that
 * throws on a length mismatch and the lengths are themselves attacker-visible;
 * the fixed-length compare below leaks length only, which a token of fixed
 * length does not care about.
 */
function tokenMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** True when the request may proceed. Always true when no token is configured. */
export function authorized(req: IncomingMessage): boolean {
  const expected = serviceToken();
  if (expected === undefined) return true;

  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || value === undefined) return false;
  return tokenMatches(value, expected);
}

/**
 * Fixed-window per-key limiter.
 *
 * A fixed window can pass up to 2x the limit across a boundary. Accepted: the
 * job here is to stop a runaway script from minting ten thousand keys, and a
 * sliding window would be more state for no practical gain at this scale.
 */
export class RateLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();
  readonly #windowMs: number;
  readonly #max: number;

  constructor(options: { windowMs: number; max: number }) {
    this.#windowMs = options.windowMs;
    this.#max = options.max;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.#hits.get(key);

    if (entry === undefined || now >= entry.resetAt) {
      // Bounded so a churn of source addresses cannot grow the map forever.
      if (this.#hits.size > 10_000) this.#hits.clear();
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }

    entry.count += 1;
    return entry.count <= this.#max;
  }
}

/** Best-effort client identity. `x-forwarded-for` only when behind a proxy. */
export function clientKey(req: IncomingMessage): string {
  if (process.env["TRUST_PROXY"] === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Applies the guard to one request. Returns true when the caller should stop —
 * the response has already been written.
 */
export function rejected(
  req: IncomingMessage,
  res: ServerResponse,
  options: { readonly limiter?: RateLimiter | undefined } = {},
): boolean {
  const cors = corsHeaders(req);

  if (!authorized(req)) {
    const body = JSON.stringify({ error: "unauthorized" });
    res.writeHead(401, {
      ...cors,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "www-authenticate": "Bearer",
    });
    res.end(body);
    return true;
  }

  if (options.limiter && !options.limiter.allow(clientKey(req))) {
    const body = JSON.stringify({ error: "rate limit exceeded" });
    res.writeHead(429, {
      ...cors,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "retry-after": "60",
    });
    res.end(body);
    return true;
  }

  return false;
}

/** One line describing the posture, for the startup banner. */
export function describeGuard(): string {
  const parts = [`bind ${bindHost()}`];
  parts.push(serviceToken() ? "token required" : "no token (open)");
  const extra = allowedOrigins();
  parts.push(extra.length > 0 ? `origins localhost + ${extra.join(", ")}` : "origins localhost only");
  return parts.join(" · ");
}
