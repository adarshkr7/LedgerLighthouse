/**
 * The whole escrow flow against real contracts, on a local fork. Nothing here touches a
 * real network: every transaction goes to the fork.
 *
 *   anvil --fork-url https://sepolia.base.org --port 8599
 *   forge build --root contracts
 *   ESCROW_ANVIL_RPC=http://127.0.0.1:8599 pnpm --filter @ntux402/e2e run escrow-flow
 *
 * See fork-stack.ts for what is real here and what is not. This script supplies the
 * decisions, so it says nothing about the encrypted limits, or that a decision was
 * earned. It says everything else in the flow holds together, and the policy itself is
 * tested in the vault's Foundry suite.
 */

import { handleTypes } from "@inco/lightning-js";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { startMockApi, type EscrowGateway } from "@ntux402/mock-api";
import {
  ScriptedAgent,
  connectLightning,
  PaymentLoop,
  VaultRelay,
  X402Client,
  paymentInfoFromTerms,
} from "@ntux402/orchestrator";
import { ERC3009_TOKEN_COLLECTOR, escrowPolicyVaultAbi, networkForChainId } from "@ntux402/shared";

import { forkAttestation } from "./escrow.js";
import { CHAIN_ID, USDC, startForkStack } from "./fork-stack.js";

const RPC = process.env["ESCROW_ANVIL_RPC"];
if (!RPC) {
  console.error("Set ESCROW_ANVIL_RPC to a local fork of Base Sepolia. See the top of this file.");
  process.exit(1);
}

const PRICE = 10_000n; // market-data, 0.01 USDC

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

console.log("\nsetting up on the fork");
const stack = await startForkStack(RPC);
const { pub, chain, vault, signer, user, userWallet, settler, vendorAddress, balance, request: rpc } = stack;
const zap = await connectLightning(networkForChainId(CHAIN_ID)!, RPC);
const relay = new VaultRelay({ rpcUrl: RPC, vaultAddress: vault, relayKey: stack.relay.key, chainId: CHAIN_ID });

let approve = true;
const decisions = {
  read: async (handle: Hex) => ({ approved: approve, signatures: [forkAttestation(handle, approve)] }),
};
const loopFor = () =>
  new PaymentLoop({
    client: new X402Client({ retry: { maxAttempts: 2, baseDelayMs: 50 } }),
    relay,
    decisions,
    signer,
    agent: new ScriptedAgent(),
    asset: USDC,
    escrow: { vault, network: `eip155:${CHAIN_ID}` },
    reclaimWaitMs: 0,
  });

// ----------------------------------------------------------------- a goal

async function openFundedGoal(budget: bigint): Promise<{ goalId: bigint; payer: Address }> {
  const payer = await signer.mintPayer();
  const encrypt = (value: bigint) =>
    zap.encrypt(value, { accountAddress: user.account.address, dappAddress: vault, handleType: handleTypes.euint256 });
  const [budgetCiphertext, perCallCapCiphertext] = (await Promise.all([encrypt(budget), encrypt(6_000_000n)])) as [Hex, Hex];

  const { request, result } = await pub.simulateContract({
    address: vault,
    abi: escrowPolicyVaultAbi,
    functionName: "openGoal",
    account: user.account,
    value: 2n * (await stack.incoFee()),
    args: [
      {
        budgetCiphertext,
        perCallCapCiphertext,
        callsRemaining: 2,
        maxAttempts: 6,
        payer,
        relay: relay.relayAddress,
        asset: USDC,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 2 * 86_400),
        allowlist: [vendorAddress],
      },
    ],
  });
  await pub.waitForTransactionReceipt({ hash: await userWallet.writeContract(request) });

  // A round amount, independent of the budget, after the goal is open.
  await stack.sendUsdc(payer, 1_000_000n);
  return { goalId: result, payer };
}

const calls = async (goalId: bigint) => {
  const goal = (await pub.readContract({
    address: vault,
    abi: escrowPolicyVaultAbi,
    functionName: "goals",
    args: [goalId],
  })) as readonly unknown[];
  return Number(goal[4]);
};
const isReclaimed = (goalId: bigint, seq: bigint) =>
  pub.readContract({ address: vault, abi: escrowPolicyVaultAbi, functionName: "isReclaimed", args: [goalId, seq] });

// ----------------------------------------------------------------- the runs

console.log("\n1. an approved purchase: held, claimed, delivered");
const first = await openFundedGoal(200_000n);
const url = `${stack.vendor.url}/resource/market-data`;
const paid = await loopFor().fetchPaid(url, first.goalId, { fresh: true });
check("the run paid", paid.kind === "paid", paid.kind === "failed" ? paid.reason : paid.kind);
check("the vendor holds the price", (await balance(vendorAddress)) === PRICE, String(await balance(vendorAddress)));
check("the payer paid it", (await balance(first.payer)) === 1_000_000n - PRICE);
if (paid.kind === "paid") {
  check("the hold has a transaction", Boolean(paid.settlement?.transaction), paid.settlement?.transaction ?? "");
  check("the claim has a transaction", Boolean(paid.settlement?.claimTransaction), paid.settlement?.claimTransaction ?? "");
  check("the data arrived", JSON.stringify(paid.data).includes("premium"));
}
check("one call was spent", (await calls(first.goalId)) === 1);

console.log("\n2. a rejected request: nothing moves");
approve = false;
const vendorBefore = await balance(vendorAddress);
const payerBefore = await balance(first.payer);
const rejected = await loopFor().fetchPaid(url, first.goalId, { fresh: true });
approve = true;
check("the run was rejected", rejected.kind === "policy-rejected", rejected.kind);
check("no money moved", (await balance(vendorAddress)) === vendorBefore && (await balance(first.payer)) === payerBefore);
if (rejected.kind === "policy-rejected") {
  const refused = await signer.authorize(first.goalId, rejected.seq);
  check("the signer refuses it", refused.kind === "refused" && refused.status === 403, refused.kind);
}

console.log("\n3. closing and sweeping: only to the owner, through the vault");
const closeHash = await userWallet.writeContract({
  address: vault,
  abi: escrowPolicyVaultAbi,
  functionName: "closeGoal",
  args: [first.goalId],
});
await pub.waitForTransactionReceipt({ hash: closeHash });
const sweep = await signer.sweep(first.goalId.toString());
if (sweep.kind !== "signed") {
  check("the signer signs a sweep", false, sweep.reason);
} else {
  const info = paymentInfoFromTerms(sweep.value.payment!);
  const refusedTheft = await pub
    .simulateContract({
      address: vault,
      abi: escrowPolicyVaultAbi,
      functionName: "charge",
      account: settler.account,
      args: [{ ...info, receiver: settler.account.address }, info.maxAmount, ERC3009_TOKEN_COLLECTOR, sweep.value.signature, 0n, info.feeReceiver],
    })
    .then(() => false)
    .catch(() => true);
  check("a sweep to anyone else is refused", refusedTheft);

  const ownerBefore = await balance(user.account.address);
  const anyone = createWalletClient({ chain, transport: http(RPC), account: settler.account });
  await pub.waitForTransactionReceipt({
    hash: await anyone.writeContract({
      address: vault,
      abi: escrowPolicyVaultAbi,
      functionName: "charge",
      args: [info, info.maxAmount, ERC3009_TOKEN_COLLECTOR, sweep.value.signature, 0n, info.feeReceiver],
    }),
  });
  check("the owner has the balance", (await balance(user.account.address)) === ownerBefore + info.maxAmount);
  check("the payer is empty", (await balance(first.payer)) === 0n);
}

console.log("\n4. a vendor that takes the hold and never claims");
const second = await openFundedGoal(300_000n);
const silent: EscrowGateway = {
  settle: (payment, requirements) => stack.gateway.settle(payment, requirements),
  claim: async () => ({ ok: false, reason: "this vendor has gone silent" }),
};
const silentVendor = await startMockApi(0, { escrow: stack.vendorOptions(silent) });
const vendorPaidSoFar = await balance(vendorAddress);
const unpaid = await loopFor().fetchPaid(`${silentVendor.url}/resource/market-data`, second.goalId, { fresh: true });
check("the run failed", unpaid.kind === "failed", unpaid.kind === "failed" ? unpaid.reason.slice(0, 90) : unpaid.kind);
check("the payer's money left it, into the hold", (await balance(second.payer)) === 1_000_000n - PRICE);
check("the vendor has nothing", (await balance(vendorAddress)) === vendorPaidSoFar);
check("the call is spent for now", (await calls(second.goalId)) === 1);

const seq = 1n;
const early = await relay.reclaimExpired(second.goalId, seq);
check("reclaiming before the deadline is refused", early.kind === "live", early.kind);

await rpc("evm_increaseTime", [3_600]);
await rpc("evm_mine", []);
const late = await relay.reclaimExpired(second.goalId, seq);
check("reclaiming after the deadline works", late.kind === "reclaimed", late.kind);
check("the money is back with the payer", (await balance(second.payer)) === 1_000_000n);
check("the vendor still has nothing", (await balance(vendorAddress)) === vendorPaidSoFar);
check("the call is back", (await calls(second.goalId)) === 2);
check("the record says so", await isReclaimed(second.goalId, seq));

await silentVendor.close();
await stack.close();

console.log(failures === 0 ? "\nEvery check held.\n" : `\n${failures} check(s) FAILED.\n`);
// Set, not process.exit: see reclaim.ts.
process.exitCode = failures === 0 ? 0 : 1;
