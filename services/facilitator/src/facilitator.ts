/**
 * A self-hosted x402 **v1** facilitator for the `exact` scheme on Base Sepolia.
 *
 * Removes the dependency on a hosted facilitator: rather than guess
 * which version a hosted facilitator speaks, we run one that speaks the version
 * we pinned. The interface (`POST /verify`, `POST /settle`) matches the hosted
 * shape, so swapping in Coinbase's is a URL change.
 *
 * ## Where this sits in the trust model
 *
 * Outside it. Plan §3 trusts the facilitator for exactly one thing — relaying a
 * signed authorization — and explicitly not for altering terms, because the
 * signature covers them. A malicious facilitator can refuse to settle, or settle
 * late. It cannot change who gets paid or how much: those bytes are inside the
 * EIP-712 digest the payer signed.
 *
 * Its key is a **gas key**. It submits `transferWithAuthorization` and pays for
 * the transaction; the USDC moves from the payer, who authorized it. This is a
 * fourth key beyond the three in IMPLEMENTATION.md §4, and it belongs to infrastructure
 * that in production someone else operates.
 *
 * ## Verification order
 *
 * Cheap and local first, then chain reads, then the transaction. Every check
 * below is a way a payment must not go through.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  usdcAbi,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "@ntux402/shared";

export interface FacilitatorConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  /** The one token this facilitator settles. Payments naming another are refused. */
  readonly asset: Address;
  readonly network: string;
  /** Gas key. Holds no user funds and authorizes no payment. */
  readonly settlerKey: Hex;
  readonly eip712Name?: string;
  readonly eip712Version?: string;
  readonly now?: () => number;
}

export class Facilitator {
  readonly #public: PublicClient;
  readonly #wallet: WalletClient;
  readonly #config: FacilitatorConfig;
  readonly #settler: Address;

  constructor(config: FacilitatorConfig) {
    this.#config = config;
    const account = privateKeyToAccount(config.settlerKey);
    this.#settler = account.address;
    this.#public = createPublicClient({
      chain: baseSepolia,
      transport: http(config.rpcUrl),
    }) as PublicClient;
    this.#wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(config.rpcUrl),
    });
  }

  get settlerAddress(): Address {
    return this.#settler;
  }

  #now(): bigint {
    return BigInt(this.#config.now?.() ?? Math.floor(Date.now() / 1000));
  }

  /**
   * Checks a payment without spending gas. The resource server calls this before
   * doing any work, so that a bad payment costs it nothing.
   */
  async verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const auth = payment.payload.authorization;

    // --- the payment is for this network and this token --------------------
    if (payment.network !== this.#config.network) {
      return invalid(`network mismatch: payment is for ${payment.network}`);
    }
    if (requirements.network !== this.#config.network) {
      return invalid(`network mismatch: requirements name ${requirements.network}`);
    }
    if (!isAddressEqual(requirements.asset, this.#config.asset)) {
      return invalid(
        `asset ${requirements.asset} is not settled by this facilitator (${this.#config.asset})`,
      );
    }

    // --- the payment matches what was asked for -----------------------------
    if (!isAddressEqual(auth.to, requirements.payTo)) {
      return invalid(`payee mismatch: authorization pays ${auth.to}, terms require ${requirements.payTo}`);
    }
    // `maxAmountRequired` is a ceiling in name and a floor in practice: the
    // resource server will not deliver for less. Paying *more* is the payer's
    // own loss, so it is not this component's business to refuse.
    if (BigInt(auth.value) < BigInt(requirements.maxAmountRequired)) {
      return invalid(
        `insufficient: authorization is for ${auth.value}, terms require ${requirements.maxAmountRequired}`,
      );
    }

    // --- the validity window ------------------------------------------------
    const now = this.#now();
    if (BigInt(auth.validAfter) > now) {
      return invalid(`authorization is not yet valid (validAfter ${auth.validAfter}, now ${now})`);
    }
    if (BigInt(auth.validBefore) <= now) {
      return invalid(`authorization expired (validBefore ${auth.validBefore}, now ${now})`);
    }

    // --- the signature ------------------------------------------------------
    // The load-bearing check: it is what makes altering terms impossible rather
    // than merely against the rules.
    let recovered: Address;
    try {
      recovered = await recoverTypedDataAddress({
        domain: {
          name: this.#config.eip712Name ?? USDC_EIP712_NAME,
          version: this.#config.eip712Version ?? USDC_EIP712_VERSION,
          chainId: this.#config.chainId,
          verifyingContract: this.#config.asset,
        },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: auth.from,
          to: auth.to,
          value: BigInt(auth.value),
          validAfter: BigInt(auth.validAfter),
          validBefore: BigInt(auth.validBefore),
          nonce: auth.nonce,
        },
        signature: payment.payload.signature,
      });
    } catch (e) {
      return invalid(`signature does not recover: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!isAddressEqual(recovered, auth.from)) {
      return invalid(`signature recovers to ${recovered}, not the declared payer ${auth.from}`);
    }

    // --- the chain agrees ----------------------------------------------------
    const [used, balance] = await Promise.all([
      this.#public.readContract({
        address: this.#config.asset,
        abi: usdcAbi,
        functionName: "authorizationState",
        args: [auth.from, auth.nonce],
      }) as Promise<boolean>,
      this.#public.readContract({
        address: this.#config.asset,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [auth.from],
      }) as Promise<bigint>,
    ]);

    if (used) {
      return invalid(`authorization ${auth.nonce} has already been used by ${auth.from}`);
    }
    if (balance < BigInt(auth.value)) {
      // The second, independent spending bound from ARCHITECTURE.md §5.5: the ephemeral
      // payer holds only what the user sent it.
      return invalid(
        `payer balance ${balance} is below the authorized ${auth.value} — the ephemeral account is underfunded`,
      );
    }

    return { isValid: true, payer: auth.from };
  }

  /**
   * Submits the authorization. Re-verifies first: `verify` and `settle` are
   * separate calls over HTTP, and state can change between them.
   *
   * Idempotent by design. If the authorization was already consumed — the retry
   * case from ARCHITECTURE.md §7.7, where the facilitator's outcome was unknown — this
   * reports success with `alreadySettled`, because the money did move and
   * submitting again would only waste gas on a revert.
   */
  async settle(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const auth = payment.payload.authorization;

    const alreadyUsed = (await this.#public.readContract({
      address: this.#config.asset,
      abi: usdcAbi,
      functionName: "authorizationState",
      args: [auth.from, auth.nonce],
    })) as boolean;

    if (alreadyUsed) {
      return {
        success: true,
        alreadySettled: true,
        network: this.#config.network,
        payer: auth.from,
      };
    }

    const check = await this.verify(payment, requirements);
    if (!check.isValid) {
      return {
        success: false,
        errorReason: check.invalidReason ?? "verification failed",
        network: this.#config.network,
        payer: auth.from,
      };
    }

    try {
      const hash = await this.#wallet.writeContract({
        address: this.#config.asset,
        abi: usdcAbi,
        functionName: "transferWithAuthorization",
        args: [
          auth.from,
          auth.to,
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce,
          payment.payload.signature,
        ],
        chain: baseSepolia,
        account: this.#wallet.account!,
      });

      const receipt = await this.#public.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        return {
          success: false,
          errorReason: `settlement transaction reverted (${hash})`,
          transaction: hash,
          network: this.#config.network,
          payer: auth.from,
        };
      }

      return {
        success: true,
        transaction: hash,
        network: this.#config.network,
        payer: auth.from,
      };
    } catch (e) {
      return {
        success: false,
        errorReason: e instanceof Error ? e.message : String(e),
        network: this.#config.network,
        payer: auth.from,
      };
    }
  }
}

function invalid(reason: string): VerifyResponse {
  return { isValid: false, invalidReason: reason };
}
