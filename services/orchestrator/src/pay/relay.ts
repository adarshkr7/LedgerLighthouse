/**
 * The orchestrator's on-chain hands: `requestSpend` and `finalizeDecision`.
 *
 * These are the *only* two writes the orchestrator makes, and the relay key that
 * pays for them is a gas key — it holds no funds and authorizes no payment
 * (ARCHITECTURE.md). Everything the orchestrator is trusted to do is here, and it
 * amounts to "submit two transactions and pay for them".
 *
 * What is deliberately absent is as important as what is present. There is no
 * method here that reads a budget handle, and there is none that produces a
 * signature. `requestSpend` carries public terms; the decision is made by Inco
 * inside the vault, and the orchestrator learns it at the same time as everyone
 * else — afterwards.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { policyVaultAbi } from "@ntux402/shared";
import { rpcTransport } from "@ntux402/shared/viem";

export interface SpendRequested {
  readonly seq: bigint;
  readonly decisionHandle: Hex;
  readonly termsHash: Hex;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly commitTx: Hex;
  readonly gasUsed: bigint;
}

export interface GoalView {
  readonly owner: Address;
  readonly payer: Address;
  readonly relay: Address;
  readonly asset: Address;
  readonly callsRemaining: number;
  readonly expiry: bigint;
  readonly seq: bigint;
  readonly open: boolean;
}

export interface VaultRelayConfig {
  readonly rpcUrl: string;
  readonly vaultAddress: Address;
  /** Gas only. Never a payer key — see ARCHITECTURE.md */
  readonly relayKey: Hex;
  readonly chainId: number;
}

export class VaultRelay {
  readonly #public: PublicClient;
  readonly #wallet: WalletClient;
  readonly #vault: Address;
  readonly #chainId: number;
  readonly #relay: Address;

  constructor(config: VaultRelayConfig) {
    const account = privateKeyToAccount(config.relayKey);
    this.#relay = account.address;
    this.#vault = config.vaultAddress;
    this.#chainId = config.chainId;
    this.#public = createPublicClient({
      chain: baseSepolia,
      transport: rpcTransport(config.rpcUrl),
    }) as PublicClient;
    this.#wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: rpcTransport(config.rpcUrl),
    });
  }

  get relayAddress(): Address {
    return this.#relay;
  }

  /** Asserted before every write. Never inferred from a wallet (ARCHITECTURE.md). */
  async assertChain(): Promise<void> {
    const actual = await this.#public.getChainId();
    if (actual !== this.#chainId) {
      throw new Error(`Wrong chain: RPC reports ${actual}, expected ${this.#chainId}`);
    }
  }

  async goal(goalId: bigint): Promise<GoalView> {
    const raw = (await this.#public.readContract({
      address: this.#vault,
      abi: policyVaultAbi,
      functionName: "goals",
      args: [goalId],
    })) as readonly [Address, Address, Address, Address, number, bigint, bigint, boolean];

    return {
      owner: raw[0],
      payer: raw[1],
      relay: raw[2],
      asset: raw[3],
      callsRemaining: raw[4],
      expiry: raw[5],
      seq: raw[6],
      open: raw[7],
    };
  }

  /**
   * Commits the spend request. The debit is applied unconditionally inside this
   * transaction via `e.select`, so by the time it confirms the outcome is
   * determined and nobody — including this process — knows what it is.
   *
   * `asset` is not a parameter. The vault reads it from the goal record,
   * because a 402 body is a claim, not a source of configuration.
   */
  async requestSpend(
    goalId: bigint,
    amount: bigint,
    payTo: Address,
    resource: string,
  ): Promise<SpendRequested> {
    await this.assertChain();

    const hash = await this.#wallet.writeContract({
      address: this.#vault,
      abi: policyVaultAbi,
      functionName: "requestSpend",
      args: [goalId, amount, payTo, resource],
      chain: baseSepolia,
      account: this.#wallet.account!,
    });

    const receipt = await this.#public.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`requestSpend reverted (${hash})`);
    }

    const logs = parseEventLogs({
      abi: policyVaultAbi,
      eventName: "SpendRequested",
      logs: receipt.logs,
    });
    const args = logs[0]?.args as
      | {
          seq: bigint;
          decisionHandle: Hex;
          termsHash: Hex;
          validAfter: bigint;
          validBefore: bigint;
        }
      | undefined;
    if (!args) throw new Error(`requestSpend emitted no SpendRequested event (${hash})`);

    return {
      seq: args.seq,
      decisionHandle: args.decisionHandle,
      termsHash: args.termsHash,
      validAfter: args.validAfter,
      validBefore: args.validBefore,
      commitTx: hash,
      gasUsed: receipt.gasUsed,
    };
  }

  /**
   * Submits the attested decision. The orchestrator may do this precisely
   * because it cannot cheat at it: `e.reveal` made the decision handle public,
   * so anyone can fetch the attestation, and the vault verifies the covalidator
   * signatures against **the handle it stored**. A wrong claim does not verify.
   */
  async finalizeDecision(
    goalId: bigint,
    seq: bigint,
    approved: boolean,
    signatures: readonly Hex[],
  ): Promise<{ txHash: Hex; gasUsed: bigint }> {
    await this.assertChain();

    const hash = await this.#wallet.writeContract({
      address: this.#vault,
      abi: policyVaultAbi,
      functionName: "finalizeDecision",
      args: [goalId, seq, approved, signatures],
      chain: baseSepolia,
      account: this.#wallet.account!,
    });

    const receipt = await this.#public.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`finalizeDecision reverted (${hash})`);
    }
    return { txHash: hash, gasUsed: receipt.gasUsed };
  }

  /**
   * The seq awaiting finalisation for this goal, or 0 when none is.
   *
   * Non-zero means a previous run committed a debit and never came back to
   * finalise it. The vault refuses every later `requestSpend` with
   * `SpendPending()` until that is cleared, so this is the read that tells the
   * loop whether it is about to hit a wall.
   */
  async pendingSeq(goalId: bigint): Promise<bigint> {
    return (await this.#public.readContract({
      address: this.#vault,
      abi: policyVaultAbi,
      functionName: "pendingSeq",
      args: [goalId],
    })) as bigint;
  }

  /** The stored decision handle for a spend, for recovering an orphan. */
  async decisionHandle(goalId: bigint, seq: bigint): Promise<Hex> {
    return (await this.#public.readContract({
      address: this.#vault,
      abi: policyVaultAbi,
      functionName: "decisionHandle",
      args: [goalId, seq],
    })) as Hex;
  }

  async isApproved(goalId: bigint, seq: bigint): Promise<boolean> {
    return this.#public.readContract({
      address: this.#vault,
      abi: policyVaultAbi,
      functionName: "isApproved",
      args: [goalId, seq],
    }) as Promise<boolean>;
  }

  /**
   * Public RPCs are load-balanced, so the node answering the next read may not
   * yet have the block a receipt came from. Bounded, and the timeout is
   * surfaced rather than slept through.
   */
  async waitUntilVisible(
    label: string,
    read: () => Promise<boolean>,
    timeoutMs = 60_000,
  ): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      try {
        if (await read()) return;
      } catch {
        /* node not ready; retry */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${label} not visible after ${timeoutMs}ms — RPC propagation exceeded the wait.`);
  }
}
