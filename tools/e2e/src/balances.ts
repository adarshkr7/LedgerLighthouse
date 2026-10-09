/**
 * Reports what every role holds. Read-only.
 *
 *   pnpm --filter @ntux402/e2e run balances
 */
import { createPublicClient, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rpcTransport, viemChain } from "@ntux402/shared/viem";
import { formatUsdc, usdcAbi } from "@ntux402/shared";

import { loadDotEnv, optional, networkFromEnv } from "./config.js";

loadDotEnv();

const { network, rpcUrl, usdcAddress: usdc } = networkFromEnv();
const client = createPublicClient({ chain: viemChain(network), transport: rpcTransport(rpcUrl) });

const roles: Array<[string, string | undefined]> = [
  ["user (DEPLOYER_PRIVATE_KEY)", optional("DEPLOYER_PRIVATE_KEY")],
  ["relay (ORCHESTRATOR_RELAY_KEY)", optional("ORCHESTRATOR_RELAY_KEY")],
  ["facilitator (FACILITATOR_PRIVATE_KEY)", optional("FACILITATOR_PRIVATE_KEY")],
];

console.log("\nRole balances on Base Sepolia\n");
for (const [label, key] of roles) {
  if (!key) {
    console.log(`  ${label.padEnd(38)} not set`);
    continue;
  }
  const { address } = privateKeyToAccount(key.startsWith("0x") ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`));
  const [eth, balance] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
  ]);
  console.log(`  ${label.padEnd(38)} ${address}`);
  console.log(`  ${"".padEnd(38)} ${formatEther(eth).padStart(12)} ETH   ${formatUsdc(balance).padStart(10)} USDC`);
}
console.log();
