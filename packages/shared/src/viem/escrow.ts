/**
 * The escrow's hashes, computed locally. A signer that asked an RPC for these would
 * be signing whatever the RPC said.
 */

import { encodeAbiParameters, keccak256, toBytes, type Hex } from "viem";

import type { PaymentInfo } from "../chain/escrow.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const PAYMENT_INFO_TYPEHASH: Hex = keccak256(
  toBytes(
    "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount," +
      "uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps," +
      "uint16 maxFeeBps,address feeReceiver,uint256 salt)",
  ),
);

/** `AuthCaptureEscrow.getHash(info)`. */
export function paymentInfoHash(info: PaymentInfo, binding: { escrow: `0x${string}`; chainId: number }): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint120" },
        { type: "uint48" },
        { type: "uint48" },
        { type: "uint48" },
        { type: "uint16" },
        { type: "uint16" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        PAYMENT_INFO_TYPEHASH,
        info.operator,
        info.payer,
        info.receiver,
        info.token,
        info.maxAmount,
        info.preApprovalExpiry,
        info.authorizationExpiry,
        info.refundExpiry,
        info.minFeeBps,
        info.maxFeeBps,
        info.feeReceiver,
        info.salt,
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }],
      [BigInt(binding.chainId), binding.escrow, inner],
    ),
  );
}

/**
 * The EIP-3009 nonce the collector will present: the hash with the payer zeroed. It
 * commits to the whole payment, operator included, which is why a signature over it
 * cannot be spent any other way.
 */
export function escrowNonce(info: PaymentInfo, binding: { escrow: `0x${string}`; chainId: number }): Hex {
  return paymentInfoHash({ ...info, payer: ZERO_ADDRESS }, binding);
}
