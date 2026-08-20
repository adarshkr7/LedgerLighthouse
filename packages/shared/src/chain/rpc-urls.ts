/**
 * Parsing the RPC endpoint list.
 *
 * `BASE_SEPOLIA_RPC_URL` accepts a comma-separated list. Kept here, on the
 * viem-free root export, because splitting a string needs no chain library and
 * the browser reads this package too. The transport that consumes the result
 * lives in `@ntux402/shared/viem`.
 */

/** Splits a comma-separated endpoint list, discarding blanks. */
export function rpcUrls(raw: string): readonly string[] {
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u !== "");
  if (urls.length === 0) throw new Error("no RPC URL configured");
  return urls;
}
