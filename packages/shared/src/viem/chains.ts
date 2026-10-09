/**
 * The viem chain object for a network.
 *
 * viem uses it for the chain id check on writes and for Base's fee handling,
 * so a client built with the wrong one fails in confusing ways. Kept on this
 * subpath with the rest of the viem-dependent code.
 */

import type { Chain } from "viem";
import { base, baseSepolia } from "viem/chains";

import type { Network } from "../chain/network.js";

export function viemChain(network: Network): Chain {
  return network.name === "base" ? base : baseSepolia;
}

/** The viem chain for a chain id, for code that is handed an id rather than a network. */
export function viemChainForId(chainId: number): Chain {
  if (chainId === base.id) return base;
  if (chainId === baseSepolia.id) return baseSepolia;
  throw new Error(`chain ${chainId} is neither Base (${base.id}) nor Base Sepolia (${baseSepolia.id})`);
}
