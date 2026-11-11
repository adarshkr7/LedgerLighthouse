/**
 * Gives approved, unpaid amounts back to their goals' budgets.
 *
 *   pnpm --filter @ntux402/e2e run reclaim                       list, send nothing
 *   pnpm --filter @ntux402/e2e run reclaim -- --execute          reclaim every one listed
 *   pnpm --filter @ntux402/e2e run reclaim -- --goal 4 --goal 9  only these goals
 *
 * ## Why this exists
 *
 * A spend the vault approved but nobody paid keeps its amount out of the
 * budget, and its call out of the count, until somebody calls
 * `reclaimExpired`. The payment loop does that itself when the authorization
 * expires within two minutes of the failure, which covers the mock vendor's
 * 60-second hold. This finds the rest: a run that crashed between approval and
 * reclaim, or a vendor whose hold outlasted the loop's wait.
 *
 * ## What it trusts
 *
 * Nothing it decides. The vault says what qualifies (`isReclaimable`): approved,
 * not yet reclaimed, and either never collected and past its window, or held by
 * the escrow and past the vendor's capture deadline. Anyone may call
 * `reclaimExpired`, so DEPLOYER_PRIVATE_KEY pays the gas. A held payment goes back
 * to the payer, and nothing else moves money.
 *
 * It reads every spend of each goal it looks at: the last 200 goals, or the ones named
 * with --goal, and says if older goals went unread. On a closed goal it lists only held payments: a budget restored there buys nothing, but the
 * money is still in the escrow. Sweep that goal again afterwards.
 */

import { createPublicClient, type Address } from "viem";
import { rpcTransport, viemChain } from "@ntux402/shared/viem";
import { formatUsdc } from "@ntux402/shared";
import { VaultRelay } from "@ntux402/orchestrator";

import { loadDotEnv, networkFromEnv, requiredAddress, requiredHexKey, vaultAbi } from "./config.js";
import { assertEscrowVault, paymentState } from "./escrow.js";

loadDotEnv();

const GOALS_SCANNED = 200n;

// --------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const goalArgs = args.flatMap((a, i) => {
  if (a !== "--goal") return [];
  const g = args[i + 1];
  if (g === undefined || !/^\d+$/.test(g)) {
    console.error(`--goal ${g ?? ""} is not a goal id`);
    process.exit(2);
  }
  return [BigInt(g)];
});

// ------------------------------------------------------------------- setup

const { network, rpcUrl } = networkFromEnv();
const vault = requiredAddress("POLICY_VAULT_ADDRESS");
const abi = vaultAbi();
const publicClient = createPublicClient({ chain: viemChain(network), transport: rpcTransport(rpcUrl) });
const relay = new VaultRelay({
  rpcUrl,
  vaultAddress: vault,
  relayKey: requiredHexKey("DEPLOYER_PRIVATE_KEY"),
  chainId: network.chainId,
});

console.log(`\nreclaim — ${execute ? "EXECUTE" : "plan only, nothing is sent (add --execute to act)"}\n`);
console.log(`  network   ${network.label}`);
console.log(`  vault     ${vault}`);
console.log(`  caller    ${relay.relayAddress}  (pays gas, authorizes nothing)\n`);

const chainId = await publicClient.getChainId();
if (chainId !== network.chainId) {
  throw new Error(`RPC is on chain ${chainId}, but NETWORK is ${network.label} (${network.chainId})`);
}
await assertEscrowVault(publicClient, vault);

// --------------------------------------------------------------- the plan

interface Candidate {
  readonly goalId: bigint;
  readonly seq: bigint;
  readonly amount: bigint;
  /** In the escrow now, and going back to the payer. */
  readonly held: bigint;
}

const read = <T>(functionName: string, callArgs: readonly unknown[]): Promise<T> =>
  publicClient.readContract({ address: vault, abi, functionName, args: callArgs } as Parameters<
    typeof publicClient.readContract
  >[0]) as Promise<T>;

const goalCount = await read<bigint>("goalCount", []);
const first = goalCount > GOALS_SCANNED ? goalCount - GOALS_SCANNED + 1n : 1n;
const ids =
  goalArgs.length > 0 ? goalArgs : Array.from({ length: Number(goalCount - first + 1n) }, (_, i) => first + BigInt(i));

if (goalArgs.length === 0 && first > 1n) {
  console.log(`  reading goals ${first} to ${goalCount}. Goals before ${first} are not read: name one with --goal.\n`);
}

const candidates: Candidate[] = [];
for (const goalId of ids) {
  const goal = await read<readonly [Address, Address, Address, Address, number, bigint, bigint, boolean]>("goals", [
    goalId,
  ]);
  const [, , , , , , lastSeq, open] = goal;
  for (let seq = 1n; seq <= lastSeq; seq++) {
    if (!(await read<boolean>("isReclaimable", [goalId, seq]))) continue;
    const { held } = await paymentState(publicClient, vault, goalId, seq);
    // A closed goal takes no more spends, so only money in the escrow is worth the gas.
    if (!open && held === 0n && goalArgs.length === 0) continue;
    const [, amount] = await read<readonly [Address, bigint, Address, Address, string]>("authorization", [goalId, seq]);
    candidates.push({ goalId, seq, amount, held });
  }
}

/**
 * Lists what qualifies and, with --execute, gives it back. Returns the exit status.
 *
 * The status is set and the process left to end by itself, because calling process.exit
 * straight after these reads made Node on Windows abort (0xC0000409, a libuv assertion on
 * a closing handle). The work was done by then, but the status said it had crashed.
 */
async function act(): Promise<number> {
  if (candidates.length === 0) {
    console.log("  nothing to reclaim: every approved spend was paid, or its window is still open\n");
    return 0;
  }

  for (const c of candidates) {
    console.log(
      `  goal ${String(c.goalId).padStart(4)}  seq ${String(c.seq).padStart(3)}  ${formatUsdc(c.amount)} USDC` +
        (c.held > 0n ? "  held by the escrow, returns to the payer" : ""),
    );
  }
  console.log();

  if (!execute) {
    console.log(`  ${candidates.length} reclaimable. Run again with --execute to give them back.\n`);
    return 0;
  }

  let failed = 0;
  for (const c of candidates) {
    try {
      const outcome = await relay.reclaimExpired(c.goalId, c.seq);
      const detail =
        outcome.kind === "reclaimed"
          ? `${network.explorer}/tx/${outcome.txHash}`
          : outcome.kind === "already"
            ? "someone reclaimed it first"
            : outcome.kind === "collected"
              ? "the vendor claimed it after all: it was paid"
              : "the vault still reads its window as open";
      console.log(`  goal ${c.goalId} seq ${c.seq}  ${outcome.kind}  ${detail}`);
    } catch (error) {
      failed++;
      console.log(`  goal ${c.goalId} seq ${c.seq}  FAILED  ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    }
  }
  console.log();
  return failed > 0 ? 1 : 0;
}

process.exitCode = await act();
