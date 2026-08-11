/**
 * Base Sepolia USDC — EIP-3009 surface and EIP-712 domain.
 *
 * The address is a checked-in constant deliberately (IMPLEMENTATION.md §7): a blank makes it
 * too easy to point the signer at whatever a 402 body claims. A 402's
 * `extra.name` / `extra.version` are *claims*; the values here — and better, the
 * ones read back off the token contract — are the truth.
 */

import type { Address } from "../x402/protocol.js";

export const USDC_BASE_SEPOLIA: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const USDC_DECIMALS = 6;

/** FiatTokenV2_2's EIP-712 domain fields. Asserted against the token's own `DOMAIN_SEPARATOR()`. */
export const USDC_EIP712_NAME = "USDC";
export const USDC_EIP712_VERSION = "2";

export const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * The EIP-3009 struct the payer signs. Field order is part of the type hash, so
 * it is not cosmetic — reordering these changes the signature.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * The authorization tuple, frozen. A retry must re-send this **byte for byte**:
 * EIP-3009 marks the whole authorization used, not just the nonce, so a
 * regenerated validity window is a *different* authorization that can execute a
 * second time (ARCHITECTURE.md §7.4).
 */
export interface TransferAuthorization {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: `0x${string}`;
}

/** Just enough of FiatTokenV2_2 to verify the domain, settle, and read state. */
export const usdcAbi = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // Only used to fund the ephemeral payer from the user's wallet — never by
    // the payment path, which moves money exclusively via EIP-3009.
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "event",
    name: "AuthorizationUsed",
    inputs: [
      { name: "authorizer", type: "address", indexed: true },
      { name: "nonce", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Renders atomic units as a human-readable USDC amount. Display only. */
export function formatUsdc(atomic: bigint): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "") || "0";
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
