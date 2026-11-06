/**
 * The Authorization Signer, for a vault that operates an auth-capture escrow.
 *
 * A signer that signs a transfer straight to the vendor has to be right about the
 * chain, because a false approval from its RPC becomes a payment. This class signs one
 * thing only, a `receiveWithAuthorization` to the escrow's collector, whose nonce
 * commits to a PaymentInfo naming the vault as operator. The token takes that only
 * from the collector, the collector only from the escrow, and the escrow only from
 * the vault, which re-checks its own record when the payment is collected.
 *
 * So the safety of a signature here does not rest on anything an RPC says. The chain
 * reads below still matter, but for a different reason: they stop this from signing
 * something useless and tell the caller why. A lie gets past them and produces a
 * signature nobody can spend.
 *
 * Three values therefore never come from the chain: the operator, the collector and
 * the token. They are fixed when this is constructed. That is the whole property, and
 * there is deliberately no route to a plain transfer anywhere in this file.
 *
 * Read `refuse()` as the specification. What this does not defend
 * against is a compromised enclave, which holds the key and can sign anything.
 */

import { domainSeparator, isAddressEqual, type Address, type Hex } from "viem";
import {
  MAX_ESCROW_AMOUNT,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  networkForChainId,
  paymentSalt,
  type PaymentInfo,
} from "@ntux402/shared";
import { escrowNonce } from "@ntux402/shared/viem";

import type { KeyStore } from "./keystore.js";
import { parseSignRequest, parseSweepRequest, type SignRequest } from "./schema.js";
import type { VaultReader } from "./vault.js";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** How long a sweep's signature stays usable. A sweep has no frozen window to read. */
const SWEEP_WINDOW_SECONDS = 3600;

export interface EscrowSignerConfig {
  readonly chainId: number;
  readonly usdcAddress: Address;
  /** The operator every signature names. The vault this signer serves. */
  readonly vaultAddress: Address;
  readonly escrow: Address;
  readonly collector: Address;
  readonly eip712Name?: string;
  readonly eip712Version?: string;
  /** On by default; a fake chain in tests may switch it off. */
  readonly verifyDomainOnChain?: boolean;
  readonly now?: () => number;
}

/** `PaymentInfo` as JSON, which has no bigint. */
export interface PaymentInfoWire {
  readonly operator: Address;
  readonly payer: Address;
  readonly receiver: Address;
  readonly token: Address;
  readonly maxAmount: string;
  readonly preApprovalExpiry: number;
  readonly authorizationExpiry: number;
  readonly refundExpiry: number;
  readonly minFeeBps: number;
  readonly maxFeeBps: number;
  readonly feeReceiver: Address;
  readonly salt: string;
}

export interface SignedEscrowAuthorization {
  readonly goalId: string;
  readonly seq: string;
  readonly token: Address;
  readonly chainId: number;
  /** What the vault's `authorize` or `charge` takes, with `signature` as collectorData. */
  readonly payment: PaymentInfoWire;
  readonly escrow: Address;
  readonly collector: Address;
  readonly authorization: {
    readonly from: Address;
    readonly to: Address;
    readonly value: string;
    readonly validAfter: string;
    readonly validBefore: string;
    readonly nonce: Hex;
  };
  readonly signature: Hex;
  /** The vault's terms hash for a spend; the zero hash for a sweep, which has none. */
  readonly termsHash: Hex;
}

export type SignOutcome<T = SignedEscrowAuthorization> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

/** What the HTTP surface serves. */
export interface SignerService<T = SignedEscrowAuthorization> {
  mintPayer(): Promise<{ address: Address }>;
  signRaw(body: unknown): Promise<SignOutcome<T>>;
  sweep(goalIdRaw: unknown): Promise<SignOutcome<T>>;
}

function refuse(status: number, error: string): SignOutcome {
  return { ok: false, status, error };
}

function samePayment(a: PaymentInfo, b: PaymentInfo): boolean {
  return (
    isAddressEqual(a.operator, b.operator) &&
    isAddressEqual(a.payer, b.payer) &&
    isAddressEqual(a.receiver, b.receiver) &&
    isAddressEqual(a.token, b.token) &&
    isAddressEqual(a.feeReceiver, b.feeReceiver) &&
    BigInt(a.maxAmount) === BigInt(b.maxAmount) &&
    Number(a.preApprovalExpiry) === Number(b.preApprovalExpiry) &&
    Number(a.authorizationExpiry) === Number(b.authorizationExpiry) &&
    Number(a.refundExpiry) === Number(b.refundExpiry) &&
    Number(a.minFeeBps) === Number(b.minFeeBps) &&
    Number(a.maxFeeBps) === Number(b.maxFeeBps) &&
    BigInt(a.salt) === BigInt(b.salt)
  );
}

export class EscrowAuthorizationSigner implements SignerService {
  readonly #vault: VaultReader;
  readonly #keys: KeyStore;
  readonly #config: Required<Omit<EscrowSignerConfig, "now">> & { now: () => number };

  constructor(options: { vault: VaultReader; keys: KeyStore; config: EscrowSignerConfig }) {
    this.#vault = options.vault;
    this.#keys = options.keys;
    const usdc = networkForChainId(options.config.chainId)?.usdc;
    const eip712Name = options.config.eip712Name ?? usdc?.eip712Name;
    const eip712Version = options.config.eip712Version ?? usdc?.eip712Version;
    if (!eip712Name || !eip712Version) {
      throw new Error(`no USDC EIP-712 domain known for chain ${options.config.chainId}`);
    }
    this.#config = {
      ...options.config,
      eip712Name,
      eip712Version,
      verifyDomainOnChain: options.config.verifyDomainOnChain ?? true,
      now: options.config.now ?? (() => Math.floor(Date.now() / 1000)),
    };
  }

  async mintPayer(): Promise<{ address: Address }> {
    return { address: await this.#keys.mint() };
  }

  async signRaw(body: unknown): Promise<SignOutcome> {
    const parsed = parseSignRequest(body);
    if (!parsed.ok) return refuse(400, parsed.error);
    return this.sign(parsed.value);
  }

  /** Signs the collection of one approved spend. The caller supplies only the pointer. */
  async sign(request: SignRequest): Promise<SignOutcome> {
    const { goalId, seq } = request;

    const chainId = await this.#vault.chainId();
    if (chainId !== this.#config.chainId) {
      return refuse(503, `refused: RPC reports chain ${chainId}, expected ${this.#config.chainId}.`);
    }

    const goal = await this.#vault.goal(goalId);
    if (!goal) return refuse(404, `refused: goal ${goalId} does not exist.`);
    if (!isAddressEqual(goal.asset, this.#config.usdcAddress)) {
      return refuse(
        409,
        `refused: goal ${goalId} is denominated in ${goal.asset}, but this signer only signs ` +
          `for ${this.#config.usdcAddress}.`,
      );
    }

    const spend = await this.#vault.spend(goalId, seq);
    if (!spend) return refuse(404, `refused: no spend recorded at (${goalId}, ${seq}).`);
    if (!spend.finalized) {
      return refuse(
        425,
        `refused: (${goalId}, ${seq}) is not finalized yet. Retry after finalizeDecision lands.`,
      );
    }
    if (!spend.approved) {
      return refuse(403, `refused: (${goalId}, ${seq}) was finalized as REJECTED by the confidential policy.`);
    }
    if (!isAddressEqual(spend.payer, goal.payer)) {
      return refuse(
        500,
        `refused: payer mismatch — goal record says ${goal.payer}, spend record says ${spend.payer}.`,
      );
    }

    if (!goal.open) {
      return refuse(409, `refused: goal ${goalId} is closed, and the vault will not collect for a closed goal.`);
    }
    if (await this.#vault.isReclaimed(goalId, seq)) {
      return refuse(410, `refused: (${goalId}, ${seq}) has already gone back to the budget.`);
    }

    // Expiry is a refusal, not a re-issue. Nothing here reads the
    // clock into the signature, so a retry is byte-identical.
    const now = BigInt(this.#config.now());
    if (spend.validBefore <= now) {
      return refuse(
        410,
        `refused: the window for (${goalId}, ${seq}) closed at ${spend.validBefore} (now ${now}). ` +
          `Request a new spend instead.`,
      );
    }
    if (spend.amount > MAX_ESCROW_AMOUNT) {
      return refuse(500, `refused: amount ${spend.amount} does not fit the escrow's 120 bits.`);
    }

    const captureDeadline = await this.#vault.captureDeadline(goalId, seq);
    const payment = this.#payment({
      payer: goal.payer,
      receiver: spend.payTo,
      maxAmount: spend.amount,
      preApprovalExpiry: Number(spend.validBefore),
      authorizationExpiry: captureDeadline,
      salt: paymentSalt(goalId, seq),
    });

    // Our derivation and the vault's must agree, or the vault would refuse the
    // signature. Failing here says why. The check adds no safety; a false answer
    // from the RPC only gets it to sign what the real vault refuses.
    const vaultsOwn = await this.#vault.escrowPayment(goalId, seq);
    if (!samePayment(payment, vaultsOwn)) {
      return refuse(500, `refused: the vault derives different payment terms for (${goalId}, ${seq}).`);
    }

    return this.#signPayment({
      goalId: goalId.toString(),
      seq: seq.toString(),
      payment,
      termsHash: spend.termsHash,
    });
  }

  /**
   * Signs the return of the payer's balance to the goal's owner. The vault's `charge`
   * re-checks on chain that the goal is closed and that this is its owner, so an RPC
   * lying about the owner gets a signature the vault refuses.
   */
  async sweep(goalIdRaw: unknown): Promise<SignOutcome> {
    const parsed = parseSweepRequest(goalIdRaw);
    if (!parsed.ok) return refuse(400, parsed.error);
    const { goalId } = parsed.value;

    const chainId = await this.#vault.chainId();
    if (chainId !== this.#config.chainId) {
      return refuse(503, `refused: RPC reports chain ${chainId}, expected ${this.#config.chainId}.`);
    }

    const goal = await this.#vault.goal(goalId);
    if (!goal) return refuse(404, `refused: goal ${goalId} does not exist.`);
    if (!isAddressEqual(goal.asset, this.#config.usdcAddress)) {
      return refuse(
        409,
        `refused: goal ${goalId} is denominated in ${goal.asset}, but this signer only signs ` +
          `for ${this.#config.usdcAddress}.`,
      );
    }
    if (goal.open) {
      return refuse(409, `refused: goal ${goalId} is still open. Close it first.`);
    }

    const amount = await this.#vault.tokenBalance(this.#config.usdcAddress, goal.payer);
    if (amount === 0n) {
      return refuse(409, `refused: payer ${goal.payer} holds no ${this.#config.usdcAddress}.`);
    }
    if (amount > MAX_ESCROW_AMOUNT) {
      return refuse(500, `refused: balance ${amount} does not fit the escrow's 120 bits.`);
    }

    // From the clock, unlike a spend, because a sweep has no frozen record. Two sweeps
    // signed at different times are different authorizations, and that is safe here:
    // every one of them can only pay the owner.
    const deadline = this.#config.now() + SWEEP_WINDOW_SECONDS;
    return this.#signPayment({
      goalId: goalId.toString(),
      seq: "sweep",
      payment: this.#payment({
        payer: goal.payer,
        receiver: goal.owner,
        maxAmount: amount,
        preApprovalExpiry: deadline,
        authorizationExpiry: deadline,
        salt: paymentSalt(goalId, 0n),
      }),
      termsHash: `0x${"00".repeat(32)}`,
    });
  }

  /** The operator and token come from configuration here, and from nowhere else. */
  #payment(fields: {
    payer: Address;
    receiver: Address;
    maxAmount: bigint;
    preApprovalExpiry: number;
    authorizationExpiry: number;
    salt: bigint;
  }): PaymentInfo {
    return {
      operator: this.#config.vaultAddress,
      token: this.#config.usdcAddress,
      payer: fields.payer,
      receiver: fields.receiver,
      maxAmount: fields.maxAmount,
      preApprovalExpiry: fields.preApprovalExpiry,
      authorizationExpiry: fields.authorizationExpiry,
      refundExpiry: fields.authorizationExpiry,
      minFeeBps: 0,
      maxFeeBps: 0,
      feeReceiver: ZERO_ADDRESS,
      salt: fields.salt,
    };
  }

  /** The only place in this file that produces a signature. */
  async #signPayment(fields: {
    goalId: string;
    seq: string;
    payment: PaymentInfo;
    termsHash: Hex;
  }): Promise<SignOutcome> {
    const { payment } = fields;

    const account = await this.#keys.signerFor(payment.payer);
    if (!account) return refuse(404, `refused: no key held for payer ${payment.payer}.`);

    const domain = {
      name: this.#config.eip712Name,
      version: this.#config.eip712Version,
      chainId: this.#config.chainId,
      verifyingContract: this.#config.usdcAddress,
    } as const;
    if (this.#config.verifyDomainOnChain) {
      const onChain = await this.#vault.tokenDomainSeparator(this.#config.usdcAddress);
      const local = domainSeparator({ domain });
      if (onChain.toLowerCase() !== local.toLowerCase()) {
        return refuse(500, `refused: EIP-712 domain mismatch. Token reports ${onChain}, we computed ${local}.`);
      }
    }

    const nonce = escrowNonce(payment, { escrow: this.#config.escrow, chainId: this.#config.chainId });
    const message = {
      from: payment.payer,
      to: this.#config.collector,
      value: payment.maxAmount,
      // The collector hard-codes these two, so anything else would not verify.
      validAfter: 0n,
      validBefore: BigInt(payment.preApprovalExpiry),
      nonce,
    };
    const signature = await account.signTypedData({
      domain,
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message,
    });

    return {
      ok: true,
      value: {
        goalId: fields.goalId,
        seq: fields.seq,
        token: this.#config.usdcAddress,
        chainId: this.#config.chainId,
        payment: {
          ...payment,
          maxAmount: payment.maxAmount.toString(),
          salt: payment.salt.toString(),
        },
        escrow: this.#config.escrow,
        collector: this.#config.collector,
        authorization: {
          from: message.from,
          to: message.to,
          value: message.value.toString(),
          validAfter: "0",
          validBefore: message.validBefore.toString(),
          nonce,
        },
        signature,
        termsHash: fields.termsHash,
      },
    };
  }
}
