/**
 * The escrow vendor's chain access: the hold goes through the facilitator, and the claim
 * is sent from this vendor's own key, because the vault accepts it from no one else.
 */

import {
  createPublicClient,
  createWalletClient,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  AUTH_CAPTURE_ESCROW,
  escrowPolicyVaultAbi,
  paymentInfoFromWire,
  type AuthCapturePayload,
  type AuthCaptureRequirements,
  type SettleResponse,
} from "@ntux402/shared";
import { paymentInfoHash, rpcTransport, sendingAccount, viemChainForId } from "@ntux402/shared/viem";

import type { ClaimOutcome, EscrowGateway } from "./escrow.js";
import type { HttpFacilitatorGateway } from "./gateway.js";

const ESCROW_STATE_ABI = parseAbi([
  "function paymentState(bytes32) view returns (bool hasCollectedPayment, uint120 capturableAmount, uint120 refundableAmount)",
]);

const NO_KEY: Hex = `0x${"00".repeat(32)}`;

export class ChainEscrowGateway implements EscrowGateway {
  readonly #facilitator: HttpFacilitatorGateway;
  readonly #public: PublicClient;
  readonly #wallet: WalletClient;
  readonly #vault: Address;
  readonly #chainId: number;
  readonly #chain: ReturnType<typeof viemChainForId>;
  readonly vendor: Address;

  constructor(options: {
    facilitator: HttpFacilitatorGateway;
    rpcUrl: string;
    chainId: number;
    vault: Address;
    /** Pays gas for `claim`, and is the address paid. */
    vendorKey: Hex;
  }) {
    this.#facilitator = options.facilitator;
    this.#vault = options.vault;
    this.#chainId = options.chainId;
    this.#chain = viemChainForId(options.chainId);
    const account = sendingAccount(options.vendorKey);
    this.vendor = account.address;
    this.#public = createPublicClient({
      chain: this.#chain,
      transport: rpcTransport(options.rpcUrl),
    }) as PublicClient;
    this.#wallet = createWalletClient({ account, chain: this.#chain, transport: rpcTransport(options.rpcUrl) });
  }

  settle(payment: AuthCapturePayload, requirements: AuthCaptureRequirements): Promise<SettleResponse> {
    return this.#facilitator.settle(payment, requirements);
  }

  async claim(goalId: bigint, seq: bigint, payment: AuthCapturePayload): Promise<ClaimOutcome> {
    try {
      // A retry after a lost response. Claiming again would revert for nothing.
      const hash = paymentInfoHash(paymentInfoFromWire(payment), {
        escrow: AUTH_CAPTURE_ESCROW,
        chainId: this.#chainId,
      });
      const [, held, captured] = (await this.#public.readContract({
        address: AUTH_CAPTURE_ESCROW,
        abi: ESCROW_STATE_ABI,
        functionName: "paymentState",
        args: [hash],
      })) as readonly [boolean, bigint, bigint];
      if (held === 0n && captured > 0n) return { ok: true };

      const transaction = await this.#wallet.writeContract({
        address: this.#vault,
        abi: escrowPolicyVaultAbi,
        functionName: "claim",
        args: [goalId, seq, NO_KEY],
        chain: this.#chain,
        account: this.#wallet.account!,
      });
      const receipt = await this.#public.waitForTransactionReceipt({ hash: transaction });
      if (receipt.status !== "success") return { ok: false, reason: `claim reverted (${transaction})` };
      return { ok: true, transaction };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
    }
  }
}
