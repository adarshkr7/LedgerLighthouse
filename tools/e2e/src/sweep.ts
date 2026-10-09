/**
 * Returns USDC stranded in payers to the owners of their goals.
 *
 *   pnpm --filter @ntux402/e2e run sweep                       list, send nothing
 *   pnpm --filter @ntux402/e2e run sweep -- --execute          close and sweep
 *   pnpm --filter @ntux402/e2e run sweep -- --goal 4 --goal 9  only these goals
 *   pnpm --filter @ntux402/e2e run sweep -- --vault 0x…        another vault
 *
 * ## Why this exists
 *
 * A goal's payer is funded up front and keeps whatever its runs did not spend.
 * Getting it back takes two steps nothing in the scripts performed: the owner
 * closes the goal, then the signer signs a transfer of the payer's whole
 * balance back to that owner. The console does both; the demo and every other
 * script left the goal open. On 9 October 2026 that had left 106.4 test USDC
 * in 59 payers on Base Sepolia. On mainnet it would be real money.
 *
 * ## What it does, per goal holding USDC
 *
 *   - closed: asks the signer for the sweep and submits it.
 *   - open, owned by DEPLOYER_PRIVATE_KEY: closes it first, then sweeps.
 *   - open, owned by anyone else: listed, never touched. Only the owner can
 *     close a goal, so that owner has to close it in the console.
 *   - a spend still pending: skipped. Closing does not stop the signer from
 *     signing an approved spend, so sweeping under a live run would race it.
 *
 * Without `--execute` it prints that plan and sends nothing.
 *
 * ## What it trusts, and what it checks
 *
 * The signer decides the transfer: payee is the goal's owner read from the
 * chain, amount is the payer's balance, and it refuses an open goal. This
 * script only carries the result, and checks it before spending gas: the
 * authorization must come from the goal's payer, pay the goal's owner, in this
 * network's USDC, for a non-zero amount. It submits `transferWithAuthorization`
 * itself, with DEPLOYER_PRIVATE_KEY paying gas, so the facilitator does not
 * need to be running.
 *
 * Goal ids repeat across vaults, and the signer reads goals from the one vault
 * it was started with. So the script reads the signer's binding from /health
 * and refuses to act when it names a different vault. To sweep the previous
 * vault, start the signer with POLICY_VAULT_ADDRESS set to it.
 *
 * A payer whose key the signer does not hold cannot be swept by anyone. The
 * signer says so only when asked for a sweep, so the plan cannot list those in
 * advance; they show up as "no key held" in the results.
 */

import { createPublicClient, createWalletClient, isAddress, isAddressEqual, type Address, type Hex } from "viem";
import { rpcTransport, sendingAccount, viemChain } from "@ntux402/shared/viem";
import { formatUsdc, policyVaultAbi, usdcAbi } from "@ntux402/shared";
import { SignerClient, askSignerToSweep } from "@ntux402/orchestrator";

import { loadDotEnv, networkFromEnv, optional, requiredAddress, requiredHexKey } from "./config.js";

loadDotEnv();

// --------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const execute = args.includes("--execute");

function values(flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag && args[i + 1] !== undefined) out.push(args[i + 1]!);
  });
  return out;
}

const vaultArg = values("--vault")[0];
if (vaultArg !== undefined && !isAddress(vaultArg)) {
  console.error(`--vault ${vaultArg} is not an address`);
  process.exit(2);
}
const goalArgs = values("--goal").map((g) => {
  if (!/^\d+$/.test(g)) {
    console.error(`--goal ${g} is not a goal id`);
    process.exit(2);
  }
  return BigInt(g);
});

// ------------------------------------------------------------------- setup

const { network, rpcUrl, usdcAddress } = networkFromEnv();
const vault = (vaultArg as Address | undefined) ?? requiredAddress("POLICY_VAULT_ADDRESS");
const operator = sendingAccount(requiredHexKey("DEPLOYER_PRIVATE_KEY"));
const signerUrl = optional("SIGNER_URL") ?? `http://127.0.0.1:${process.env["SIGNER_PORT"] ?? 8402}`;
const signer = new SignerClient(
  signerUrl,
  undefined,
  optional("SIGNER_SERVICE_TOKEN") ?? optional("SERVICE_TOKEN"),
);

const chain = viemChain(network);
const publicClient = createPublicClient({ chain, transport: rpcTransport(rpcUrl) });
const wallet = createWalletClient({ account: operator, chain, transport: rpcTransport(rpcUrl) });
const tx = (hash: Hex) => `${network.explorer}/tx/${hash}`;

console.log(`\nsweep — ${execute ? "EXECUTE" : "plan only, nothing is sent (add --execute to act)"}\n`);
console.log(`  network   ${network.label}${network.testnet ? "" : " (REAL MONEY)"}`);
console.log(`  vault     ${vault}`);
console.log(`  operator  ${operator.address}  (closes its own goals, pays gas)`);
console.log(`  signer    ${signerUrl}\n`);

const chainId = await publicClient.getChainId();
if (chainId !== network.chainId) {
  throw new Error(`RPC is on chain ${chainId}, but NETWORK is ${network.label} (${network.chainId})`);
}

// --------------------------------------------------------------- the plan

type Action =
  | "sweep"
  | "close-and-sweep"
  | "owner-must-close"
  | "pending-spend"
  | "other-asset"
  | "shared-payer"
  | "payer-is-owner";

interface Candidate {
  readonly goalId: bigint;
  readonly owner: Address;
  readonly payer: Address;
  readonly open: boolean;
  readonly balance: bigint;
  readonly action: Action;
}

const goalCount = (await publicClient.readContract({
  address: vault,
  abi: policyVaultAbi,
  functionName: "goalCount",
})) as bigint;

const ids = goalArgs.length > 0 ? goalArgs : Array.from({ length: Number(goalCount) }, (_, i) => BigInt(i + 1));

const candidates: Candidate[] = [];
/*
 * A vault without the payer binding (the one retired on 9 October) let two
 * goals name one payer. Its balance is listed once, under the first goal, so
 * the totals do not count the same USDC twice.
 */
const seenPayers = new Map<string, bigint>();
for (const goalId of ids) {
  if (goalId < 1n || goalId > goalCount) {
    console.log(`  goal ${goalId}: does not exist on this vault (goalCount ${goalCount})`);
    continue;
  }
  const [owner, payer, , asset, , , , open] = (await publicClient.readContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "goals",
    args: [goalId],
  })) as readonly [Address, Address, Address, Address, number, bigint, bigint, boolean];

  const balance = (await publicClient.readContract({
    address: usdcAddress,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [payer],
  })) as bigint;
  if (balance === 0n) continue;

  let action: Action;
  const firstGoal = seenPayers.get(payer.toLowerCase());
  if (firstGoal !== undefined) {
    action = "shared-payer";
  } else if (isAddressEqual(payer, owner)) {
    // Early goals on the retired vault named the owner's own wallet as the
    // payer. That balance is the owner's wallet, not money left behind.
    action = "payer-is-owner";
  } else if (!isAddressEqual(asset, usdcAddress)) {
    action = "other-asset";
  } else if (!open) {
    action = "sweep";
  } else if (!isAddressEqual(owner, operator.address)) {
    action = "owner-must-close";
  } else {
    const pending = (await publicClient.readContract({
      address: vault,
      abi: policyVaultAbi,
      functionName: "pendingSeq",
      args: [goalId],
    })) as bigint;
    action = pending === 0n ? "close-and-sweep" : "pending-spend";
  }
  if (firstGoal === undefined) seenPayers.set(payer.toLowerCase(), goalId);
  const counted = action === "shared-payer" || action === "payer-is-owner" ? 0n : balance;
  candidates.push({ goalId, owner, payer, open, balance: counted, action });
}

const LABEL: Record<Action, string> = {
  sweep: "sweep",
  "close-and-sweep": "close, then sweep",
  "owner-must-close": "owner must close it in the console",
  "pending-spend": "skipped: a spend is pending",
  "other-asset": "skipped: goal is not in this network's USDC",
  "shared-payer": "skipped: same payer as an earlier goal, counted there",
  "payer-is-owner": "nothing to recover: the payer is the owner's own wallet",
};

const total = (list: readonly Candidate[]) => list.reduce((sum, c) => sum + c.balance, 0n);
const actionable = candidates.filter((c) => c.action === "sweep" || c.action === "close-and-sweep");

console.log(`  ${ids.length} goal(s) read, ${candidates.length} with USDC in the payer\n`);
for (const c of candidates) {
  console.log(
    `  goal ${String(c.goalId).padStart(4)}  ${c.open ? "open  " : "closed"}  ${formatUsdc(c.balance).padStart(9)} USDC  ` +
      `owner ${c.owner.slice(0, 10)}…  ${LABEL[c.action]}`,
  );
}
console.log(`\n  recoverable now      ${formatUsdc(total(actionable))} USDC in ${actionable.length} goal(s), if the signer holds their keys`);
const others = candidates.filter((c) => c.action === "owner-must-close");
if (others.length > 0) {
  console.log(`  needs another owner  ${formatUsdc(total(others))} USDC in ${others.length} goal(s)`);
}

if (!execute || actionable.length === 0) {
  console.log(execute ? "\n  Nothing to do.\n" : "\n  Plan only. Run again with --execute to close and sweep.\n");
  process.exit(0);
}

// ------------------------------------------------------- the signer's vault

const health = await fetch(`${signerUrl}/health`)
  .then((r) => (r.ok ? (r.json() as Promise<{ vault?: string; chainId?: number }>) : undefined))
  .catch(() => undefined);
if (!health) throw new Error(`signer is not reachable at ${signerUrl}. Start it first.`);
if (health.vault === undefined) {
  throw new Error("the signer does not report which vault it reads. Restart it on the current code.");
}
if (!isAddressEqual(health.vault as Address, vault) || health.chainId !== network.chainId) {
  throw new Error(
    `the signer reads vault ${health.vault} on chain ${health.chainId}, not ${vault} on ${network.chainId}. ` +
      `Goal ids repeat across vaults, so its sweeps would be for different goals. Restart it with ` +
      `POLICY_VAULT_ADDRESS=${vault}.`,
  );
}

// ---------------------------------------------------------------- execute

console.log("");
let recovered = 0n;
const failures: string[] = [];

for (const c of actionable) {
  const label = `goal ${c.goalId}`;
  try {
    if (c.action === "close-and-sweep") {
      const hash = await wallet.writeContract({
        address: vault,
        abi: policyVaultAbi,
        functionName: "closeGoal",
        args: [c.goalId],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`closeGoal reverted (${hash})`);
      console.log(`  ${label}: closed      ${tx(hash)}`);
    }

    // Every goal here is closed, so a "still open" is a stale read. See askSignerToSweep.
    const outcome = await askSignerToSweep(signer, String(c.goalId));
    if (outcome.kind === "unreachable") throw new Error(`signer unreachable: ${outcome.reason}`);
    if (outcome.kind === "refused") {
      // 404 with "no key held" is the unrecoverable case, and says so itself.
      failures.push(`${label}: signer refused (HTTP ${outcome.status}): ${outcome.reason}`);
      console.log(`  ${label}: signer refused (HTTP ${outcome.status}): ${outcome.reason}`);
      continue;
    }

    // Carried, not trusted: the token re-verifies the signature, but a
    // transfer to anyone but the goal's owner is not worth the gas to find out.
    const { authorization: a, signature, token } = outcome.value;
    const value = BigInt(a.value);
    if (
      !isAddressEqual(a.from, c.payer) ||
      !isAddressEqual(a.to, c.owner) ||
      !isAddressEqual(token, usdcAddress) ||
      value === 0n
    ) {
      throw new Error(
        `the signer's authorization does not match the goal: from ${a.from} to ${a.to}, ` +
          `${value} of ${token}; expected from ${c.payer} to ${c.owner} in ${usdcAddress}`,
      );
    }

    const hash = await wallet.writeContract({
      address: usdcAddress,
      abi: usdcAbi,
      functionName: "transferWithAuthorization",
      args: [a.from, a.to, value, BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, signature],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transferWithAuthorization reverted (${hash})`);
    recovered += value;
    console.log(`  ${label}: swept ${formatUsdc(value)} USDC to ${a.to.slice(0, 10)}…  ${tx(hash)}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n")[0]! : String(e);
    failures.push(`${label}: ${detail}`);
    console.log(`  ${label}: FAILED  ${detail}`);
  }
}

console.log(`\n  recovered  ${formatUsdc(recovered)} USDC`);
if (failures.length > 0) {
  console.log(`  failed     ${failures.length} goal(s), listed above`);
}
console.log("");
process.exit(failures.length > 0 ? 1 : 0);
