/**
 * Settles x402 `auth-capture` payments through the published `@x402/evm` facilitator.
 *
 * This is where the x402 packages belong in this system. A facilitator is outside the
 * trust model: it can refuse or delay a payment, and the signature stops it changing
 * one. So a dependency here cannot widen what anyone can spend. It must never reach the
 * signer, and `pnpm check:boundary` enforces that.
 *
 * It only ever relays `authorize`, into the vaults on its allowlist. Capturing is the
 * vendor's own call to the vault, and for a custom operator the scheme says so.
 *
 * Needs an RPC that answers `eth_simulateV1`, which the SDK uses to check a custom
 * operator's effect before spending gas.
 */

import {
  createPublicClient,
  createWalletClient,
  isAddressEqual,
  parseAbi,
  publicActions,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/facilitator";
import {
  AUTH_CAPTURE_ESCROW,
  paymentInfoFromWire,
  type AuthCapturePayload,
  type AuthCaptureRequirements,
} from "@ntux402/shared";
import { paymentInfoHash, rpcTransport, sendingAccount, viemChainForId } from "@ntux402/shared/viem";

const ESCROW_STATE_ABI = parseAbi([
  "function paymentState(bytes32) view returns (bool hasCollectedPayment, uint120 capturableAmount, uint120 refundableAmount)",
]);

export interface AuthCaptureConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  /** The one token this facilitator settles. */
  readonly asset: Address;
  /** Gas key. Holds no user funds and authorizes no payment. */
  readonly settlerKey: Hex;
  /** The vaults whose payments this relays. Nothing else is admitted. */
  readonly operators: readonly Address[];
}

export interface AuthCaptureVerifyResponse {
  readonly isValid: boolean;
  readonly invalidReason?: string | undefined;
  readonly payer?: string | undefined;
}

export interface AuthCaptureSettleResponse {
  readonly success: boolean;
  readonly errorReason?: string | undefined;
  readonly transaction?: string | undefined;
  readonly network?: string | undefined;
  readonly payer?: string | undefined;
  /** This payment had already been collected, so nothing was sent. */
  readonly alreadySettled?: boolean | undefined;
}

/** The part of the SDK's scheme used here, so tests need no chain. */
export interface SettlementScheme {
  verify(payload: never, requirements: never): Promise<AuthCaptureVerifyResponse>;
  settle(payload: never, requirements: never): Promise<AuthCaptureSettleResponse>;
}

export class AuthCaptureFacilitator {
  readonly #scheme: SettlementScheme;
  readonly #config: AuthCaptureConfig;
  readonly #readState: (hash: Hex) => Promise<boolean>;

  constructor(
    config: AuthCaptureConfig,
    injected?: { scheme: SettlementScheme; readCollected: (hash: Hex) => Promise<boolean> },
  ) {
    if (config.operators.length === 0) throw new Error("auth-capture needs at least one operator");
    this.#config = config;

    if (injected) {
      this.#scheme = injected.scheme;
      this.#readState = injected.readCollected;
      return;
    }

    const chain = viemChainForId(config.chainId);
    const account = sendingAccount(config.settlerKey);
    const client = createWalletClient({ account, chain, transport: rpcTransport(config.rpcUrl) }).extend(
      publicActions,
    );
    const reader = createPublicClient({ chain, transport: rpcTransport(config.rpcUrl) }) as PublicClient;

    this.#scheme = new AuthCaptureEvmScheme(
      toFacilitatorEvmSigner({
        address: account.address,
        readContract: (args: never) => client.readContract(args),
        verifyTypedData: (args: never) => client.verifyTypedData(args),
        writeContract: (args: never) => client.writeContract(args),
        sendTransaction: (args: never) => client.sendTransaction(args),
        waitForTransactionReceipt: (args: never) => client.waitForTransactionReceipt(args),
        getCode: (args: never) => client.getCode(args),
        simulateCalls: (args: never) => client.simulateCalls(args),
      } as never),
      { operators: config.operators.map((address) => ({ address, operatorType: "custom" as const })) } as never,
    ) as unknown as SettlementScheme;

    this.#readState = async (hash) => {
      const [collected] = (await reader.readContract({
        address: AUTH_CAPTURE_ESCROW,
        abi: ESCROW_STATE_ABI,
        functionName: "paymentState",
        args: [hash],
      })) as readonly [boolean, bigint, bigint];
      return collected;
    };
  }

  /** The network this settles, in x402 v2's naming. */
  get network(): string {
    return `eip155:${this.#config.chainId}`;
  }

  get operators(): readonly Address[] {
    return this.#config.operators;
  }

  /** Refusals that need no chain and no SDK. */
  #refusal(payment: AuthCapturePayload, requirements: AuthCaptureRequirements): string | undefined {
    if (requirements.network !== this.network) return `network mismatch: requirements name ${requirements.network}`;
    if (!isAddressEqual(requirements.asset, this.#config.asset)) {
      return `asset ${requirements.asset} is not settled by this facilitator`;
    }
    // The server's terms and the ones the client says it accepted must be the same terms.
    if (JSON.stringify(payment.accepted) !== JSON.stringify(requirements)) {
      return "the payment accepted different terms from the ones required";
    }
    if (!this.#config.operators.some((operator) => isAddressEqual(operator, requirements.extra.captureAuthorizer))) {
      return `operator ${requirements.extra.captureAuthorizer} is not on this facilitator's allowlist`;
    }
    return undefined;
  }

  async verify(payment: AuthCapturePayload, requirements: AuthCaptureRequirements): Promise<AuthCaptureVerifyResponse> {
    const refusal = this.#refusal(payment, requirements);
    if (refusal) return { isValid: false, invalidReason: refusal };
    return this.#scheme.verify(payment as never, requirements as never);
  }

  /**
   * Idempotent, like `Facilitator.settle`. The SDK answers a repeat with a simulation
   * failure, which would read as a refused payment when the money did move. A caller
   * whose response was lost has to be able to ask again, so the escrow is asked first.
   */
  async settle(payment: AuthCapturePayload, requirements: AuthCaptureRequirements): Promise<AuthCaptureSettleResponse> {
    const payer = payment.payload.authorization.from;
    const refusal = this.#refusal(payment, requirements);
    if (refusal) return { success: false, errorReason: refusal, network: this.network, payer };

    const hash = paymentInfoHash(paymentInfoFromWire(payment), {
      escrow: AUTH_CAPTURE_ESCROW,
      chainId: this.#config.chainId,
    });
    if (await this.#readState(hash)) {
      return { success: true, alreadySettled: true, network: this.network, payer };
    }
    return this.#scheme.settle(payment as never, requirements as never);
  }
}
