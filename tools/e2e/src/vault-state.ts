/**
 * Prints the live state of the deployed PolicyVault: every goal, every spend,
 * and the decision on each.
 *
 *   pnpm --filter @ntux402/e2e run state
 *
 * Reads through the **signer's** `OnChainVaultReader`, deliberately. That makes
 * it a smoke test of the exact code path the signer uses to decide whether to
 * sign — if the ABI drifts or a view changes shape, this notices before a
 * demo does. Read-only; it holds no key and sends no transaction.
 */

import { OnChainVaultReader } from "@ntux402/signer";
import { USDC_BASE_SEPOLIA, formatUsdc } from "@ntux402/shared";
import { createPublicClient, http, type Address } from "viem";
import { baseSepolia } from "viem/chains";

import { loadDotEnv, policyVaultAbi, required, requiredAddress } from "./config.js";

loadDotEnv();

const rpcUrl = required("BASE_SEPOLIA_RPC_URL");
const vaultAddress = requiredAddress("POLICY_VAULT_ADDRESS");

const reader = new OnChainVaultReader({ rpcUrl, vaultAddress });
const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
const abi = policyVaultAbi();

console.log(`\nPolicyVault ${vaultAddress}`);
console.log(`chain ${await reader.chainId()}\n`);

const goalCount = (await client.readContract({
  address: vaultAddress,
  abi,
  functionName: "goalCount",
})) as bigint;

if (goalCount === 0n) {
  console.log("No goals opened yet.\n");
  process.exit(0);
}

for (let goalId = 1n; goalId <= goalCount; goalId++) {
  const goal = await reader.goal(goalId);
  if (!goal) continue;

  const budgetHandle = (await client.readContract({
    address: vaultAddress,
    abi,
    functionName: "remainingBudgetHandle",
    args: [goalId],
  })) as `0x${string}`;

  const cap = (await client.readContract({
    address: vaultAddress,
    abi,
    functionName: "perCallCap",
    args: [goalId],
  })) as bigint;

  console.log(`goal ${goalId}  ${goal.open ? "open" : "closed"}`);
  console.log(`  owner          ${goal.owner}`);
  console.log(`  payer          ${goal.payer}`);
  console.log(`  relay          ${goal.relay}`);
  console.log(`  asset          ${goal.asset}${
    goal.asset.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase() ? "  (Base Sepolia USDC)" : "  (NOT USDC)"
  }`);
  console.log(`  perCallCap     ${formatUsdc(cap)} USDC`);
  console.log(`  callsRemaining ${goal.callsRemaining}`);
  console.log(`  budget handle  ${budgetHandle}   <- opaque bytes32`);
  console.log(`  spends         ${goal.seq}`);

  for (let seq = 1n; seq <= goal.seq; seq++) {
    const spend = await reader.spend(goalId, seq);
    if (!spend) continue;
    const state = !spend.finalized ? "PENDING" : spend.approved ? "APPROVED" : "REJECTED";
    const used = await reader.authorizationUsed(goal.asset as Address, goal.payer, spend.nonce);
    console.log(
      `    seq ${seq}  ${state.padEnd(8)} ${formatUsdc(spend.amount).padStart(8)} USDC -> ${spend.payTo}` +
        `  auth ${used ? "SETTLED" : "unused"}`,
    );
  }
  console.log();
}
