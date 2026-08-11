/**
 * Self-hosted x402 v1 facilitator for the `exact` scheme on Base Sepolia.
 *
 * Outside the trust boundary (ARCHITECTURE.md §2): trusted to relay a signed
 * authorization, not to alter terms — the EIP-712 signature covers those.
 */

export * from "./facilitator.js";
export * from "./http.js";
