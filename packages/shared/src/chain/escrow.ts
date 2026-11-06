/**
 * The parts of commerce-payments' AuthCaptureEscrow the services need.
 *
 * Browser-safe: no viem. The hash that needs a chain library is in
 * `@ntux402/shared/viem`.
 */

/**
 * The v1.1 deployment named by x402's auth-capture scheme. These are CREATE2
 * addresses; on 6 November 2026 the escrow's bytecode read identically on Base and
 * Base Sepolia. Constants, not configuration: which contracts a signature is good
 * for is the thing a compromised configuration must not be able to change.
 */
export const AUTH_CAPTURE_ESCROW = "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c" as const;
export const ERC3009_TOKEN_COLLECTOR = "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88" as const;

/** The escrow's `PaymentInfo`, field for field. */
export interface PaymentInfo {
  readonly operator: `0x${string}`;
  readonly payer: `0x${string}`;
  readonly receiver: `0x${string}`;
  readonly token: `0x${string}`;
  readonly maxAmount: bigint;
  readonly preApprovalExpiry: number;
  readonly authorizationExpiry: number;
  readonly refundExpiry: number;
  readonly minFeeBps: number;
  readonly maxFeeBps: number;
  readonly feeReceiver: `0x${string}`;
  readonly salt: bigint;
}

/** The largest amount `PaymentInfo.maxAmount` can hold. */
export const MAX_ESCROW_AMOUNT = 2n ** 120n - 1n;

/**
 * Identifies a payment by its goal and sequence number, as EscrowPolicyVault reads
 * it back. A sweep has no spend record and uses sequence number 0.
 */
export function paymentSalt(goalId: bigint, seq: bigint): bigint {
  return (goalId << 64n) | seq;
}

/** EIP-3009's pull-style authorization. Only `to` may submit it. */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
