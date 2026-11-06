/**
 * Prints the live state of the deployed EscrowPolicyVault: every goal, every spend,
 * and the decision on each.
 *
 *   pnpm --filter @ntux402/e2e run state
 *
 * Reads through the **signer's** `OnChainVaultReader`, deliberately. That makes
 * it a smoke test of the exact code path the signer uses to decide whether to
 * sign — if the ABI drifts or a view changes shape, this notices before a
 * demo does. Read-only; it holds no key and sends no transaction.
 */

import { rpcTransport, viemChain } from "@ntux402/shared/viem";
import { OnChainVaultReader } from "@ntux402/signer";
import { formatUsdc } from "@ntux402/shared";
import { createPublicClient } from "viem";

import { loadDotEnv, requiredAddress, networkFromEnv, vaultAbi } from "./config.js";
import { assertEscrowVault, paymentState } from "./escrow.js";

loadDotEnv();

const { network, rpcUrl, usdcAddress } = networkFromEnv();
const vaultAddress = requiredAddress("POLICY_VAULT_ADDRESS");

const reader = new OnChainVaultReader({ rpcUrl, vaultAddress, chainId: network.chainId });
const client = createPublicClient({ chain: viemChain(network), transport: rpcTransport(rpcUrl) });
const abi = vaultAbi();
await assertEscrowVault(client, vaultAddress);

console.log(`\nEscrowPolicyVault ${vaultAddress}`);
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

  const capHandle = (await client.readContract({
    address: vaultAddress,
    abi,
    functionName: "perCallCapHandle",
    args: [goalId],
  })) as `0x${string}`;

  console.log(`goal ${goalId}  ${goal.open ? "open" : "closed"}`);
  console.log(`  owner          ${goal.owner}`);
  console.log(`  payer          ${goal.payer}`);
  console.log(`  relay          ${goal.relay}`);
  console.log(`  asset          ${goal.asset}${
    goal.asset.toLowerCase() === usdcAddress.toLowerCase() ? `  (${network.label} USDC)` : "  (NOT USDC)"
  }`);
  console.log(`  cap handle     ${capHandle}   <- encrypted, opaque bytes32`);
  console.log(`  callsRemaining ${goal.callsRemaining}`);
  console.log(`  budget handle  ${budgetHandle}   <- opaque bytes32`);
  console.log(`  spends         ${goal.seq}`);

  for (let seq = 1n; seq <= goal.seq; seq++) {
    const spend = await reader.spend(goalId, seq);
    if (!spend) continue;
    const state = !spend.finalized ? "PENDING" : spend.approved ? "APPROVED" : "REJECTED";
    const money = await paymentState(client, vaultAddress, goalId, seq);
    const where = money.captured > 0n ? "PAID" : money.held > 0n ? "HELD" : money.collected ? "returned" : "not collected";
    console.log(
      `    seq ${seq}  ${state.padEnd(8)} ${formatUsdc(spend.amount).padStart(8)} USDC -> ${spend.payTo}` +
        `  ${where}`,
    );
  }
  console.log();
}
