/**
 * The orchestrator's on-chain hands: `requestSpend`, `finalizeDecision`,
 * `reclaimExpired` and, on an escrow vault, `sweep`.
 *
 * These are the *only* writes the orchestrator makes, and the relay key that
 * pays for them is a gas key — it holds no funds and authorizes no payment
 * (ARCHITECTURE.md). Everything the orchestrator is trusted to do is here, and it
 * amounts to "submit these transactions and pay for them". `reclaimExpired` can only
 * ever give money back to the budget, `sweep` can only pay the goal's owner, and the
 * vault decides whether either may happen.
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
import { escrowPolicyVaultAbi, policyVaultAbi } from "@ntux402/shared";
import { rpcTransport, sendingAccount, viemChainForId } from "@ntux402/shared/viem";

import type { EscrowPaymentTerms } from "./signer-client.js";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/**
 * The struct the vault and the escrow take. The signer signs no fee on any payment and
 * the vault refuses any other terms, so the fee fields are constants, not inputs.
 */
export function paymentInfoFromTerms(payment: EscrowPaymentTerms) {
  return {
    operator: payment.operator,
    payer: payment.payer,
    receiver: payment.receiver,
    token: payment.token,
    maxAmount: BigInt(payment.maxAmount),
    preApprovalExpiry: payment.preApprovalExpiry,
    authorizationExpiry: payment.authorizationExpiry,
    refundExpiry: payment.refundExpiry,
    minFeeBps: 0,
    maxFeeBps: 0,
    feeReceiver: ZERO_ADDRESS,
    salt: BigInt(payment.salt),
  };
}

export interface SpendRequested {
  readonly seq: bigint;
  readonly decisionHandle: Hex;
  readonly termsHash: Hex;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly commitTx: Hex;
  readonly gasUsed: bigint;
}

/**
 * What `reclaimExpired` found. Every case but `reclaimed` is the vault's own
 * refusal, read back by name, because each one means something different about
 * where the money is.
 */
export type ReclaimOutcome =
  /** The budget and the call came back. */
  | { readonly kind: "reclaimed"; readonly txHash: Hex; readonly gasUsed: bigint }
  /** The token consumed the authorization: the money left the payer. */
  | { readonly kind: "collected" }
  /** Somebody reclaimed it first. Anyone may. */
  | { readonly kind: "already" }
  /** The authorization can still be used, so nothing can come back yet. */
  | { readonly kind: "live" };

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
  readonly #chain: ReturnType<typeof viemChainForId>;
  /** `goalId:seq` for every finalize this relay saw confirmed. See `requestSpend`. */
  readonly #finalized = new Set<string>();

  constructor(config: VaultRelayConfig) {
    const account = sendingAccount(config.relayKey);
    this.#relay = account.address;
    this.#vault = config.vaultAddress;
    this.#chainId = config.chainId;
    this.#chain = viemChainForId(config.chainId);
    this.#public = createPublicClient({
      chain: this.#chain,
      transport: rpcTransport(config.rpcUrl),
    }) as PublicClient;
    this.#wallet = createWalletClient({
      account,
      chain: this.#chain,
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
   *
   * `payBy` is when the vendor stops holding what it quoted, in unix seconds.
   * The vault ends the authorization there, so a payment that arrives after the
   * vendor let the thing go cannot be collected.
   *
   * ## A SpendPending that is not real
   *
   * Public Base RPCs are load balanced, and the node that estimates gas can be
   * behind the node that returned the last receipt. A `requestSpend` sent right
   * after this relay's own `finalizeDecision` then reverts in estimation with
   * `SpendPending`, for a spend that is already finalized. The adversary
   * campaign hit this on 9 October 2026.
   *
   * So a `SpendPending` is checked before it is believed. If the vault's
   * pending seq reads as zero, or as a seq this relay has seen finalized, the
   * estimate came from a stale node and the call is retried. Nothing was
   * broadcast, so a retry cannot double-commit. Any other pending seq is a
   * real one, and the refusal goes straight back to the caller.
   */
  async requestSpend(
    goalId: bigint,
    amount: bigint,
    payTo: Address,
    resource: string,
    payBy: bigint,
  ): Promise<SpendRequested> {
    return this.#withStaleRetry(goalId, () => this.#requestSpendOnce(goalId, amount, payTo, resource, payBy));
  }

  /**
   * The same request on an EscrowPolicyVault, which also records when the vendor must
   * claim by, and the hash of the key that releases the goods, or zero for none.
   */
  async requestEscrowSpend(
    goalId: bigint,
    amount: bigint,
    payTo: Address,
    resource: string,
    payBy: bigint,
    captureDeadline: number,
    keyHash: Hex,
  ): Promise<SpendRequested> {
    return this.#withStaleRetry(goalId, () =>
      this.#commit(goalId, "requestEscrowSpend", () =>
        this.#wallet.writeContract({
          address: this.#vault,
          abi: escrowPolicyVaultAbi,
          functionName: "requestEscrowSpend",
          args: [goalId, amount, payTo, resource, payBy, captureDeadline, keyHash],
          chain: this.#chain,
          account: this.#wallet.account!,
        }),
      ),
    );
  }

  async #withStaleRetry(goalId: bigint, once: () => Promise<SpendRequested>): Promise<SpendRequested> {
    const attempts = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        return await once();
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (attempt >= attempts || !text.includes("SpendPending")) throw error;
        const pending = await this.pendingSeq(goalId);
        const stale = pending === 0n || this.#finalized.has(`${goalId}:${pending}`);
        if (!stale) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  async #requestSpendOnce(
    goalId: bigint,
    amount: bigint,
    payTo: Address,
    resource: string,
    payBy: bigint,
  ): Promise<SpendRequested> {
    return this.#commit(goalId, "requestSpend", () =>
      this.#wallet.writeContract({
        address: this.#vault,
        abi: policyVaultAbi,
        functionName: "requestSpend",
        args: [goalId, amount, payTo, resource, payBy],
        chain: this.#chain,
        account: this.#wallet.account!,
      }),
    );
  }

  async #commit(goalId: bigint, name: string, send: () => Promise<Hex>): Promise<SpendRequested> {
    await this.assertChain();

    const hash = await send();

    const receipt = await this.#public.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${name} reverted (${hash})`);
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
    if (!args) throw new Error(`${name} emitted no SpendRequested event (${hash})`);

    // The next write on this spend is a finalize, and a node that has not seen
    // this block yet refuses it with `UnknownSpend`. The adversary campaign hit
    // that on 9 October 2026, when C8 finalized straight after its commit. So
    // return once the spend is readable. Best effort: the receipt is already
    // proof of the commit, and losing it to a slow node would orphan the spend.
    await this.waitUntilVisible(
      `spend ${goalId}:${args.seq}`,
      async () => (await this.pendingSeq(goalId)) === args.seq,
      30_000,
    ).catch(() => undefined);

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
      chain: this.#chain,
      account: this.#wallet.account!,
    });

    const receipt = await this.#public.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`finalizeDecision reverted (${hash})`);
    }
    this.#finalized.add(`${goalId}:${seq}`);
    return { txHash: hash, gasUsed: receipt.gasUsed };
  }

  /**
   * Asks the vault to put an approved, unpaid amount back in the budget.
   *
   * Safe to call whenever: the vault refuses unless the authorization's window
   * has closed and the token never consumed it, and those refusals come back as
   * outcomes, not errors. Anything else throws.
   *
   * `AuthorizationLive` is retried for a short while. The caller waits for
   * `validBefore` by its own clock, and the node that estimates gas can be a
   * block or two behind it, which the vault reads as a window still open.
   */
  async reclaimExpired(goalId: bigint, seq: bigint): Promise<ReclaimOutcome> {
    const attempts = 6;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#reclaimOnce(goalId, seq);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (text.includes("AuthorizationUsed")) return { kind: "collected" };
        if (text.includes("AlreadyReclaimed")) return { kind: "already" };
        if (!text.includes("AuthorizationLive")) throw error;
        if (attempt >= attempts) return { kind: "live" };
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  async #reclaimOnce(goalId: bigint, seq: bigint): Promise<ReclaimOutcome> {
    await this.assertChain();

    const hash = await this.#wallet.writeContract({
      address: this.#vault,
      abi: policyVaultAbi,
      functionName: "reclaimExpired",
      args: [goalId, seq],
      chain: this.#chain,
      account: this.#wallet.account!,
    });

    const receipt = await this.#public.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`reclaimExpired reverted (${hash})`);
    }
    return { kind: "reclaimed", txHash: hash, gasUsed: receipt.gasUsed };
  }

  /**
   * Submits a signed return of the payer's balance through the vault's `charge`.
   *
   * Anyone may send this, and it can only pay the goal's owner: the vault checks the
   * receiver against its own record. The collector is read from the vault, so nothing
   * from the signer's response is trusted beyond the signature it covers.
   *
   * `GoalStillOpen` is retried because the node that estimates gas can be behind the
   * receipt of the `closeGoal` that came just before this.
   */
  async sweep(payment: EscrowPaymentTerms, signature: Hex): Promise<{ txHash: Hex; gasUsed: bigint }> {
    await this.assertChain();
    const collector = (await this.#public.readContract({
      address: this.#vault,
      abi: escrowPolicyVaultAbi,
      functionName: "collector",
    })) as Address;

    const info = paymentInfoFromTerms(payment);
    const attempts = 6;
    for (let attempt = 1; ; attempt++) {
      try {
        const hash = await this.#wallet.writeContract({
          address: this.#vault,
          abi: escrowPolicyVaultAbi,
          functionName: "charge",
          args: [info, info.maxAmount, collector, signature, 0n, ZERO_ADDRESS],
          chain: this.#chain,
          account: this.#wallet.account!,
        });
        const receipt = await this.#public.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`charge reverted (${hash})`);
        return { txHash: hash, gasUsed: receipt.gasUsed };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (attempt >= attempts || !text.includes("GoalStillOpen")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  /**
   * True when this relay itself saw `finalizeDecision` for `(goalId, seq)` confirmed.
   *
   * A `pendingSeq` read that names such a seq came from a node behind our own
   * receipt, not from a genuinely unfinished spend.
   */
  hasFinalized(goalId: bigint, seq: bigint): boolean {
    return this.#finalized.has(`${goalId}:${seq}`);
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

  /** The frozen authorization window, in unix seconds. */
  async validityWindow(goalId: bigint, seq: bigint): Promise<{ validAfter: bigint; validBefore: bigint }> {
    const [validAfter, validBefore] = (await this.#public.readContract({
      address: this.#vault,
      abi: policyVaultAbi,
      functionName: "validityWindow",
      args: [goalId, seq],
    })) as readonly [bigint, bigint];
    return { validAfter, validBefore };
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
