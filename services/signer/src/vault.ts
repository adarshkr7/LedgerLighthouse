/**
 * The signer's only window onto the world: the chain.
 *
 * Non-negotiable #3 (ARCHITECTURE.md) — "the signer reads the chain, never
 * the caller." This module is that sentence in code. Every field the signer
 * later puts inside an EIP-3009 signature comes from here.
 *
 * It is an interface with a viem implementation behind it so the service can be
 * tested against a fake chain. That is a testing seam, not a trust seam: the
 * production path reads a real contract over a real RPC.
 */

import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { policyVaultAbi, usdcAbi } from "@ntux402/shared";
import { rpcTransport } from "@ntux402/shared/viem";

/** The goal record, as stored on chain. */
export interface GoalRecord {
  readonly owner: Address;
  readonly payer: Address;
  readonly relay: Address;
  readonly asset: Address;
  readonly callsRemaining: number;
  readonly expiry: bigint;
  readonly seq: bigint;
  readonly open: boolean;
}

/** The frozen authorization tuple plus the flags that gate it. */
export interface SpendRecord {
  readonly payer: Address;
  readonly amount: bigint;
  readonly payTo: Address;
  readonly asset: Address;
  readonly nonce: Hex;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly termsHash: Hex;
  readonly finalized: boolean;
  readonly approved: boolean;
}

export interface VaultReader {
  chainId(): Promise<number>;
  goal(goalId: bigint): Promise<GoalRecord | undefined>;
  spend(goalId: bigint, seq: bigint): Promise<SpendRecord | undefined>;
  /** The token's own EIP-712 domain separator — the authoritative one. */
  tokenDomainSeparator(token: Address): Promise<Hex>;
  /** True once the token has consumed this authorization. */
  authorizationUsed(token: Address, authorizer: Address, nonce: Hex): Promise<boolean>;
  /** ERC-20 balance, for sweeping a payer back to its owner. */
  tokenBalance(token: Address, holder: Address): Promise<bigint>;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class OnChainVaultReader implements VaultReader {
  readonly #client: PublicClient;
  readonly #vault: Address;

  constructor(options: { rpcUrl: string; vaultAddress: Address; client?: PublicClient }) {
    this.#client =
      options.client ??
      (createPublicClient({
        chain: baseSepolia,
        transport: rpcTransport(options.rpcUrl),
      }) as PublicClient);
    this.#vault = options.vaultAddress;
  }

  async chainId(): Promise<number> {
    return this.#client.getChainId();
  }

  async goal(goalId: bigint): Promise<GoalRecord | undefined> {
    const raw = (await this.#client.readContract({
      address: this.#vault,
      abi: policyVaultAbi,
      functionName: "goals",
      args: [goalId],
    })) as readonly [Address, Address, Address, Address, number, bigint, bigint, boolean];

    if (raw[0].toLowerCase() === ZERO_ADDRESS) return undefined;

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

  async spend(goalId: bigint, seq: bigint): Promise<SpendRecord | undefined> {
    const base = { address: this.#vault, abi: policyVaultAbi, args: [goalId, seq] } as const;

    const [authorization, window, termsHash, finalized, approved] = await Promise.all([
      this.#client.readContract({ ...base, functionName: "authorization" }) as Promise<
        readonly [Address, bigint, Address, Address, Hex]
      >,
      this.#client.readContract({ ...base, functionName: "validityWindow" }) as Promise<
        readonly [bigint, bigint]
      >,
      this.#client.readContract({ ...base, functionName: "termsHash" }) as Promise<Hex>,
      this.#client.readContract({ ...base, functionName: "isFinalized" }) as Promise<boolean>,
      this.#client.readContract({ ...base, functionName: "isApproved" }) as Promise<boolean>,
    ]);

    // `amount == 0` is the vault's own "no such spend" sentinel: `requestSpend`
    // rejects a zero amount, so a zero here means the record was never written.
    if (authorization[1] === 0n) return undefined;

    return {
      payer: authorization[0],
      amount: authorization[1],
      payTo: authorization[2],
      asset: authorization[3],
      nonce: authorization[4],
      validAfter: window[0],
      validBefore: window[1],
      termsHash,
      finalized,
      approved,
    };
  }

  async tokenBalance(token: Address, holder: Address): Promise<bigint> {
    return (await this.#client.readContract({
      address: token,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [holder],
    })) as bigint;
  }

  async tokenDomainSeparator(token: Address): Promise<Hex> {
    return this.#client.readContract({
      address: token,
      abi: usdcAbi,
      functionName: "DOMAIN_SEPARATOR",
    }) as Promise<Hex>;
  }

  async authorizationUsed(token: Address, authorizer: Address, nonce: Hex): Promise<boolean> {
    return this.#client.readContract({
      address: token,
      abi: usdcAbi,
      functionName: "authorizationState",
      args: [authorizer, nonce],
    }) as Promise<boolean>;
  }
}
