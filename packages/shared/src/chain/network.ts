/**
 * The networks this system runs on, and everything that differs between them.
 *
 * One table, read by every service and the console, so a deployment is on one
 * network or refuses to start. The failure this prevents is a mixed setup: a
 * signer building EIP-712 domains for one chain while the vault lives on
 * another produces signatures that look fine and are rejected at settlement.
 *
 * ## What differs, and why each field is here
 *
 * - `usdc.eip712Name` is the one that bites. Circle's USDC on Base Sepolia
 *   calls itself "USDC"; on Base mainnet it is "USD Coin". The name is part of
 *   the EIP-712 domain every transfer authorization is signed over, so the
 *   testnet value on mainnet signs authorizations the token will not accept.
 *   Both values were read from the contracts' own `name()` on 27 September 2026.
 * - `x402Network` is the string a 402 carries in `network`. x402 v1 uses names,
 *   not CAIP-2 ids.
 * - `incoProbeHandle` is a decision already revealed on this network, which the
 *   orchestrator asks Inco to reveal again to learn whether Inco is up. Absent
 *   until a run on that network has produced one.
 * - `testnet` is false exactly when money is real. Code that should refuse to
 *   guess on mainnet reads this.
 *
 * Inco's executor is the same address on both (0x4b9911b0…8624), which is why
 * one compiled PolicyVault serves either network.
 *
 * Browser-safe: no viem, no node APIs. The viem chain objects live in
 * `@ntux402/shared/viem`, and reading the choice from the environment lives in
 * `@ntux402/shared/node`.
 */

import type { Address } from "../x402/protocol.js";

export type NetworkName = "base-sepolia" | "base";

export interface Network {
  readonly name: NetworkName;
  /** For people: logs, the console, error messages. */
  readonly label: string;
  readonly chainId: number;
  /** False exactly when USDC and gas are real money. */
  readonly testnet: boolean;
  /** The `network` string in an x402 v1 payment requirement. */
  readonly x402Network: string;
  readonly usdc: {
    readonly address: Address;
    /** EIP-712 domain `name`. Differs between the two networks; see above. */
    readonly eip712Name: string;
    readonly eip712Version: string;
  };
  /**
   * Used only when no RPC is configured. Public endpoints, rate limited.
   * publicnode first: `sepolia.base.org` has been seen answering most methods
   * while returning -32011 for `eth_call`, and the list is tried in order.
   */
  readonly defaultRpcUrls: readonly string[];
  /** Block explorer origin, for links. */
  readonly explorer: string;
  /** A decision handle already revealed on this network, for the Inco health probe. */
  readonly incoProbeHandle?: `0x${string}`;
}

export const NETWORKS: Readonly<Record<NetworkName, Network>> = {
  "base-sepolia": {
    name: "base-sepolia",
    label: "Base Sepolia",
    chainId: 84532,
    testnet: true,
    x402Network: "base-sepolia",
    usdc: {
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      eip712Name: "USDC",
      eip712Version: "2",
    },
    defaultRpcUrls: ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"],
    explorer: "https://sepolia.basescan.org",
    // Goal 47, seq 1 on the Base Sepolia PolicyVault: approved and finalized.
    incoProbeHandle: "0xc76c2592384d77ec2b8b85b1a4924b4edaf089266ee6798e3eefbae279df0000",
  },
  base: {
    name: "base",
    label: "Base",
    chainId: 8453,
    testnet: false,
    x402Network: "base",
    usdc: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      eip712Name: "USD Coin",
      eip712Version: "2",
    },
    defaultRpcUrls: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    explorer: "https://basescan.org",
  },
};

/** The network a name refers to. Unset means Base Sepolia; real money is never the default. */
export function networkNamed(name: string | undefined): Network {
  const key = (name ?? "").trim() || "base-sepolia";
  if (key in NETWORKS) return NETWORKS[key as NetworkName];
  throw new Error(`NETWORK=${key} is not a known network. Use one of: ${Object.keys(NETWORKS).join(", ")}`);
}

/** The network with this chain id, or undefined. For checking what an RPC or wallet reports. */
export function networkForChainId(chainId: number): Network | undefined {
  return Object.values(NETWORKS).find((n) => n.chainId === chainId);
}
