/**
 * Building an RPC transport from configuration.
 *
 * Every service used `http(rpcUrl)` against one endpoint, and a public endpoint
 * is a single point of failure that fails in the least convenient way: not by
 * going down, but by going *partially* down. `sepolia.base.org` has been
 * observed answering `eth_blockNumber` while returning
 * `-32011 no backend is currently healthy` for `eth_call` — so a liveness check
 * passes and the contract reads that actually matter do not.
 *
 * `BASE_SEPOLIA_RPC_URL` therefore accepts a comma-separated list, and more
 * than one entry produces a viem `fallback` transport: requests go to the first
 * endpoint and move to the next on failure, with viem's own ranking taking
 * sustained latency into account. One entry behaves exactly as before, so
 * nothing has to change to keep working.
 *
 * `retryCount` is raised from viem's default of 3. These are free public
 * endpoints and a transient 503 is routine; a few more attempts costs
 * milliseconds and removes a class of spurious failure that is very hard to
 * explain while standing in front of an audience.
 */

import { fallback, http, type Transport } from "viem";

import { rpcUrls } from "../chain/rpc-urls.js";

export interface TransportOptions {
  /** Attempts per endpoint before viem gives up on it. */
  readonly retryCount?: number;
  /** Per-request timeout in ms. */
  readonly timeout?: number;
}

/**
 * A transport for one or more endpoints.
 *
 * Single URL: a plain `http` transport, identical to what each service built
 * by hand before. Several: a `fallback` that fails over between them.
 */
export function rpcTransport(raw: string, options: TransportOptions = {}): Transport {
  const urls = rpcUrls(raw);
  const config = {
    retryCount: options.retryCount ?? 5,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  };

  const transports = urls.map((url) => http(url, config));
  // `rank: false` keeps the configured order authoritative. The first entry is
  // the one an operator chose; automatic re-ranking would quietly promote a
  // fast-but-rate-limited public endpoint above a paid one.
  return transports.length === 1 ? (transports[0] as Transport) : fallback(transports, { rank: false });
}
