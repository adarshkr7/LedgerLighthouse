/**
 * x402 protocol constants — **pinned to v1**.
 *
 * v1 uses the `X-PAYMENT` request header and `X-PAYMENT-RESPONSE` on the way back.
 * v2 renames these to `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`
 * and expresses `network` as CAIP-2 (`eip155:84532`). We build against v1 only, and
 * the mock API speaks only v1 (plan §6.1).
 */

export const X402_VERSION = 1;

export const HEADER_PAYMENT = "X-PAYMENT";
export const HEADER_PAYMENT_RESPONSE = "X-PAYMENT-RESPONSE";

/** v1 spells networks as slugs, not CAIP-2. */
export const NETWORK_BASE_SEPOLIA = "base-sepolia";

/** The only x402 scheme this project implements. */
export const SCHEME_EXACT = "exact";

/** Base Sepolia USDC — 6 decimals, FiatTokenV2_2. Public, and checked in deliberately. */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export type Address = `0x${string}`;
