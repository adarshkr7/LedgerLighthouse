/**
 * Proves that whoever is asking for a lease back is the party that paid for it.
 *
 * ## Why a lease needs this and a job does not
 *
 * Plan §5.2 keys the lease store on the vault's spend nonce, which is what
 * makes a retry idempotent: the nonce is `keccak256(abi.encode(goalId, seq))`,
 * so an interrupted settlement retried byte for byte lands on the same lease
 * instead of provisioning a second machine.
 *
 * That nonce is public. It is derived from two small integers, it is emitted in
 * `SpendRequested`, and it is written into every trace. If presenting a nonce
 * were enough to be handed the lease it paid for, then anyone who read a log
 * could ask this service for a live credential, and §5.1's "scoped to the
 * lease" would be scoped to a secret that is not one.
 *
 * What is not public is the payer's signature over the EIP-3009 authorization.
 * Only the key that signed it can produce it, so checking it locally is what
 * separates "this caller paid for this lease" from "this caller knows a number
 * that appears in a block explorer".
 *
 * ## Why locally, and not at the facilitator
 *
 * `/verify` is the wrong instrument for the retry path, because the retry path
 * exists precisely when a nonce has already been consumed — which is what
 * `/verify` is supposed to decline. Asking it would refuse every genuine retry
 * and accept nothing else.
 *
 * The check here is narrower and needs no network: recover the signer of the
 * typed data and compare it to the `from` field the payload claims. It says
 * nothing about whether the money can still move, which is the facilitator's
 * business and is already settled by the time a retry happens.
 *
 * ## What a failure costs
 *
 * Nothing gets provisioned either way. The §5.2 lock is unconditional: a nonce
 * that already has a lease never provisions a second machine, whether or not
 * the signature checks out. This gate controls one thing, which is whether the
 * credential goes back out — so a misconfigured domain costs a buyer a refused
 * retry, and never costs anyone a leaked capability or a duplicate GPU.
 */

import { verifyTypedData } from "viem";
import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  type Address,
  type PaymentPayload,
} from "@ntux402/shared";

/** What the handler needs. Narrow, so a test can stand in without a key. */
export interface PayerCheck {
  signedByPayer(payment: PaymentPayload, asset: Address): Promise<boolean>;
}

export interface Eip3009PayerCheckOptions {
  readonly chainId: number;
  /** Overridable for a token whose domain is not USDC's. */
  readonly name?: string;
  readonly version?: string;
}

export class Eip3009PayerCheck implements PayerCheck {
  readonly #chainId: number;
  readonly #name: string;
  readonly #version: string;

  constructor(options: Eip3009PayerCheckOptions) {
    this.#chainId = options.chainId;
    this.#name = options.name ?? USDC_EIP712_NAME;
    this.#version = options.version ?? USDC_EIP712_VERSION;
  }

  async signedByPayer(payment: PaymentPayload, asset: Address): Promise<boolean> {
    const auth = payment.payload.authorization;
    try {
      return await verifyTypedData({
        address: auth.from as Address,
        domain: {
          name: this.#name,
          version: this.#version,
          chainId: this.#chainId,
          verifyingContract: asset,
        },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: auth.from as Address,
          to: auth.to as Address,
          value: BigInt(auth.value),
          validAfter: BigInt(auth.validAfter),
          validBefore: BigInt(auth.validBefore),
          nonce: auth.nonce as `0x${string}`,
        },
        signature: payment.payload.signature as `0x${string}`,
      });
    } catch {
      // A malformed signature, a non-numeric field, a bad address: all of them
      // mean the same thing here, which is that nothing proved anything.
      return false;
    }
  }
}
