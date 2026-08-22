/**
 * Committing a finished trace's Merkle root to chain.
 *
 * The trace is already tamper-evident on its own: every step hashes the one
 * before it, so an edit anywhere changes every hash after it. What a local file
 * cannot do is prove *when* it said what it says. Nothing stops a trace being
 * rewritten wholesale — recomputing the chain and the root as you go — before
 * anybody reads it.
 *
 * Thirty-two bytes on chain closes that. After the anchor lands, the only trace
 * that can produce this root is the one that existed at that block, and the
 * standalone verifier can check it with the file and a public RPC. Someone
 * *without* the trace learns nothing from the root, which is why it is the root
 * that goes on chain and not the trace: prompts, purchased data and vendor
 * relationships all stay off it.
 *
 * ## Why failure here is not a run failure
 *
 * Anchoring happens after the money has moved and the trace is already written
 * to disk. A failed anchor costs the commitment, not the record — so it is
 * reported and swallowed rather than thrown. Turning a completed, settled,
 * fully-traced run into an error because a 32-byte write ran out of gas would be
 * losing the thing to protect the receipt for it.
 *
 * ## Why re-anchoring is a success, not an error
 *
 * `TraceAnchor` is first-write-wins: a second anchor for the same goal reverts
 * with `AlreadyAnchored`. That is the contract behaving correctly — it is what
 * stops an anchorer revising history — and it is also what happens on a perfectly
 * ordinary second run against the same goal. Treating it as a failure would put
 * a red line in the log every time someone ran a goal twice.
 */

import {
  createPublicClient,
  createWalletClient,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { traceAnchorAbi } from "@ntux402/shared";
import { rpcTransport } from "@ntux402/shared/viem";

export type AnchorOutcome =
  | { readonly kind: "anchored"; readonly txHash: Hex; readonly root: Hex }
  /** Already committed — the expected result of a second run against one goal. */
  | { readonly kind: "already"; readonly root: Hex }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface TraceAnchorClientConfig {
  readonly rpcUrl: string;
  readonly anchorAddress: Address;
  /** Gas only — the same relay key, and it authorizes no payment. */
  readonly relayKey: Hex;
  readonly chainId: number;
  /**
   * Injectable clients, for tests.
   *
   * `VaultRelay` builds its own and is not unit-tested as a result; this one is
   * worth testing because its interesting behaviour is in what it *declines* to
   * do — the empty trace, the wrong chain, the second run against a goal that
   * is already anchored. Those are all decisions made before any write, and
   * they are the paths a live demo actually hits.
   */
  readonly clients?: { publicClient: PublicClient; walletClient: WalletClient };
}

export class TraceAnchorClient {
  readonly #public: PublicClient;
  readonly #wallet: WalletClient;
  readonly #address: Address;
  readonly #chainId: number;

  constructor(config: TraceAnchorClientConfig) {
    this.#address = config.anchorAddress;
    this.#chainId = config.chainId;
    this.#public =
      config.clients?.publicClient ??
      (createPublicClient({
        chain: baseSepolia,
        transport: rpcTransport(config.rpcUrl),
      }) as PublicClient);
    this.#wallet =
      config.clients?.walletClient ??
      createWalletClient({
        account: privateKeyToAccount(config.relayKey),
        chain: baseSepolia,
        transport: rpcTransport(config.rpcUrl),
      });
  }

  /**
   * Anchors `root` for `(vault, goalId)`.
   *
   * Reads the existing anchor first. That read is not a race guard — the
   * contract enforces first-write-wins itself — it is there so the ordinary
   * "already anchored" case costs one `eth_call` instead of a reverted
   * transaction and the gas that goes with it.
   */
  async anchor(
    vault: Address,
    goalId: bigint,
    root: Hex,
    stepCount: number,
  ): Promise<AnchorOutcome> {
    if (stepCount === 0) return { kind: "skipped", reason: "empty trace" };

    try {
      const actual = await this.#public.getChainId();
      if (actual !== this.#chainId) {
        return {
          kind: "failed",
          reason: `wrong chain: RPC reports ${actual}, expected ${this.#chainId}`,
        };
      }

      const existing = (await this.#public.readContract({
        address: this.#address,
        abi: traceAnchorAbi,
        functionName: "anchorOf",
        args: [vault, goalId],
      })) as { root: Hex };

      if (existing.root !== ZERO_ROOT) {
        return { kind: "already", root: existing.root };
      }

      const hash = await this.#wallet.writeContract({
        address: this.#address,
        abi: traceAnchorAbi,
        functionName: "anchor",
        args: [vault, goalId, root, stepCount],
        chain: baseSepolia,
        account: this.#wallet.account!,
      });

      const receipt = await this.#public.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        return { kind: "failed", reason: `anchor reverted (${hash})` };
      }
      return { kind: "anchored", txHash: hash, root };
    } catch (e) {
      return { kind: "failed", reason: e instanceof Error ? e.message : String(e) };
    }
  }
}

const ZERO_ROOT: Hex = `0x${"00".repeat(32)}`;
