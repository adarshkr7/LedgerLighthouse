/**
 * The Inco Lightning client for the network this process runs on.
 *
 * Every entry point used to call `Lightning.baseSepoliaTestnet()` directly, so
 * the network was decided in eight places and none of them read `NETWORK`.
 * Base and Base Sepolia share an executor address but not a deployment record,
 * and a client bound to the wrong one reads handles from the wrong chain.
 */

import { Lightning } from "@inco/lightning-js/lite";
import { rpcUrls, type Network } from "@ntux402/shared";

export function connectLightning(network: Network, rpcUrl: string) {
  const options = { hostChainRpcUrls: [...rpcUrls(rpcUrl)] };
  return network.testnet ? Lightning.baseSepoliaTestnet(options) : Lightning.baseMainnet(options);
}
