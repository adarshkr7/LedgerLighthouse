/**
 * Tops the relay and facilitator up with gas from the user account.
 *
 *   pnpm --filter @ntux402/e2e run fund
 *
 * Both are gas-only roles, so this moves ETH and never USDC. It saves two
 * faucet trips when the user account already has Base Sepolia ETH — and it is
 * plain ETH transfers, so there is nothing clever to get wrong.
 */

import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { loadDotEnv, optional, required, requiredHexKey } from "./config.js";

loadDotEnv();

/** Enough for many requestSpend/finalize/settle cycles; small enough to be disposable. */
const TARGET = parseEther("0.005");

const rpcUrl = required("BASE_SEPOLIA_RPC_URL");
const user = privateKeyToAccount(requiredHexKey("DEPLOYER_PRIVATE_KEY"));

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
const wallet = createWalletClient({ account: user, chain: baseSepolia, transport: http(rpcUrl) });

const roles = [
  ["relay", optional("ORCHESTRATOR_RELAY_KEY")],
  ["facilitator", optional("FACILITATOR_PRIVATE_KEY")],
] as const;

console.log(`\nFunding gas roles from ${user.address}`);
console.log(`  available ${formatEther(await publicClient.getBalance({ address: user.address }))} ETH\n`);

for (const [label, key] of roles) {
  if (!key) {
    console.log(`  ${label.padEnd(12)} skipped — key not set in .env`);
    continue;
  }
  const address = privateKeyToAccount(
    key.startsWith("0x") ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`),
  ).address;

  const balance = await publicClient.getBalance({ address });
  if (balance >= TARGET) {
    console.log(`  ${label.padEnd(12)} ${address}  already has ${formatEther(balance)} ETH`);
    continue;
  }

  const topUp = TARGET - balance;
  const hash = await wallet.sendTransaction({ to: address, value: topUp });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  ${label.padEnd(12)} ${address}  +${formatEther(topUp)} ETH  ${hash}`);
}

console.log(
  `\n  remaining ${formatEther(await publicClient.getBalance({ address: user.address }))} ETH\n`,
);
