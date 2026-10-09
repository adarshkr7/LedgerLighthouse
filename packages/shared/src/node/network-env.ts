/**
 * Which network this process runs on, read from the environment once.
 *
 * `NETWORK` picks the row in `NETWORKS`. Everything chain-specific that used to
 * be its own variable is derived from it, and the old variables still work as
 * *assertions*: a `.env` that sets `CHAIN_ID=84532` next to `NETWORK=base`
 * describes two networks at once, and this refuses to start rather than pick
 * one. That mix is the failure worth refusing loudly, because every piece of
 * it looks valid on its own.
 *
 * RPC endpoints come from `RPC_URL`. On Base Sepolia the older
 * `BASE_SEPOLIA_RPC_URL` is still read, so an existing `.env` keeps working.
 * With neither set, the network's public endpoints are used.
 */

import { networkNamed, type Network } from "../chain/network.js";
import type { Address } from "../x402/protocol.js";
import { optional } from "./env.js";

export interface NetworkEnv {
  readonly network: Network;
  /** Comma-separated, as `rpcTransport` and `rpcUrls` expect. */
  readonly rpcUrl: string;
  readonly usdcAddress: Address;
}

export function networkFromEnv(): NetworkEnv {
  const network = networkNamed(optional("NETWORK"));

  const chainId = optional("CHAIN_ID");
  if (chainId !== undefined && Number(chainId) !== network.chainId) {
    throw new Error(
      `CHAIN_ID=${chainId} does not match NETWORK=${network.name} (chain ${network.chainId}). ` +
        `Remove CHAIN_ID; it is derived from NETWORK now.`,
    );
  }

  const usdc = optional("USDC_ADDRESS");
  if (usdc !== undefined && usdc.toLowerCase() !== network.usdc.address.toLowerCase()) {
    throw new Error(
      `USDC_ADDRESS=${usdc} is not ${network.label} USDC (${network.usdc.address}). ` +
        `Remove USDC_ADDRESS; it is derived from NETWORK now.`,
    );
  }

  const rpcUrl =
    optional("RPC_URL") ??
    (network.name === "base-sepolia" ? optional("BASE_SEPOLIA_RPC_URL") : undefined) ??
    network.defaultRpcUrls.join(",");

  return { network, rpcUrl, usdcAddress: network.usdc.address };
}
