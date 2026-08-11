/**
 * x402 protocol constants — **pinned to v1**.
 *
 * v1 uses the `X-PAYMENT` request header and `X-PAYMENT-RESPONSE` on the way back.
 * v2 renames these to `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`
 * and expresses `network` as CAIP-2 (`eip155:84532`). We build against v1 only, and
 * the mock API speaks only v1 (ARCHITECTURE.md §6.1).
 */

export const X402_VERSION = 1;

export const HEADER_PAYMENT = "X-PAYMENT";
export const HEADER_PAYMENT_RESPONSE = "X-PAYMENT-RESPONSE";

/** v1 spells networks as slugs, not CAIP-2. */
export const NETWORK_BASE_SEPOLIA = "base-sepolia";

/** The only x402 scheme this project implements. */
export const SCHEME_EXACT = "exact";

export type Address = `0x${string}`;

// `USDC_BASE_SEPOLIA` lives in ../chain/usdc.ts, next to the EIP-3009 surface and
// the EIP-712 domain it belongs with. Still re-exported from the package root.
