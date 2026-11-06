/**
 * Runs the operator scripts themselves, as separate processes, against the escrow flow
 * on a local fork. Nothing here touches a real network.
 *
 *   anvil --fork-url https://sepolia.base.org --port 8599 --block-time 1
 *   forge build --root contracts
 *   ESCROW_ANVIL_RPC=http://127.0.0.1:8599 pnpm --filter @ntux402/e2e run fork-tools
 *
 * `--block-time` matters. The chain's clock only moves with its blocks, and C6 needs it
 * to pass a deadline while nothing is being sent.
 *
 * This is what the scripts can be tested on before an escrow vault is deployed. See
 * fork-stack.ts for what is real. In particular the decisions come from the stand-in in
 * escrow.ts, which applies the policy in the clear, so a pass here says the scripts and
 * the flow work and says nothing about the encrypted comparison. Only a run on the real
 * network can say that.
 *
 * A fork takes a few minutes: the campaign's C6 waits out a 60-second hold.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleTypes } from "@inco/lightning-js";
import { type Address, type Hex } from "viem";
import { startMockApi, type EscrowGateway } from "@ntux402/mock-api";
import {
  PaymentLoop,
  ScriptedAgent,
  VaultRelay,
  X402Client,
  connectLightning,
} from "@ntux402/orchestrator";
import { networkForChainId } from "@ntux402/shared";

import { forkAttestation, paymentState } from "./escrow.js";
import { CHAIN_ID, USDC, startForkStack } from "./fork-stack.js";

const RPC = process.env["ESCROW_ANVIL_RPC"];
if (!RPC) {
  console.error("Set ESCROW_ANVIL_RPC to a local fork of Base Sepolia. See the top of this file.");
  process.exit(1);
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

console.log("\nsetting up on the fork");
const stack = await startForkStack(RPC);
const { pub, vault, user, userWallet, vendorAddress, balance, signer, request } = stack;

// Enough for every script below. Goals return it through the sweep at the end.
await stack.sendUsdc(user.account.address, 1_500_000n);
const ownerStart = await balance(user.account.address);

const cwd = fileURLToPath(new URL("..", import.meta.url));
const benchDir = mkdtempSync(join(tmpdir(), "fork-bench-"));

/**
 * One script, in its own process, seeing only what a real operator's .env would give it.
 *
 * Not spawnSync: the signer, facilitator and vendor live in this process, and blocking
 * it would leave them unable to answer the script being waited for.
 */
async function script(name: string, args: readonly string[] = []): Promise<boolean> {
  console.log(`\n=== ${name} ${args.join(" ")} ${"=".repeat(Math.max(0, 60 - name.length))}\n`);
  const child = spawn("pnpm", ["exec", "tsx", `src/${name}.ts`, ...args], {
    cwd,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, ...stack.env },
  });
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  console.log(`\n=== ${name} exited ${status}`);
  return status === 0;
}

const results: Array<[string, boolean]> = [];
const run = async (name: string, args: readonly string[] = []) =>
  results.push([`${name} ${args.join(" ")}`.trim(), await script(name, args)]);

await run("demo");
await run("bench", ["--approved", "3", "--rejected", "2", "--out", benchDir]);
await run("tee-check");
await run("adversary");
await run("vault-state");
await run("reclaim");
await run("sweep");
await run("sweep", ["--execute"]);

console.log("\n=== what those scripts left behind\n");
for (const [name, ok] of results) check(`${name} exited 0`, ok);
// Exact, so that a run whose purchases quietly failed cannot pass on its returned funding.
check("the vendor was paid for the demo's one purchase and bench's three", (await balance(vendorAddress)) === 40_000n, String(await balance(vendorAddress)));
// C22 leaves one 500-unit payment held until its capture deadline.
check("the owner got back everything else", (await balance(user.account.address)) === ownerStart - 40_000n - 500n);

// A vendor that takes the hold and never claims, on a goal the owner then closes. The
// money is in neither the payer nor the vendor, so it needs reclaim and then sweep.
console.log("\n=== money in the escrow on a closed goal\n");
const before = await balance(user.account.address);
const vendorBefore = await balance(vendorAddress);
const zap = await connectLightning(networkForChainId(CHAIN_ID)!, RPC);
const relay = new VaultRelay({ rpcUrl: RPC, vaultAddress: vault, relayKey: stack.relay.key, chainId: CHAIN_ID });
const payer: Address = await signer.mintPayer();
const encrypt = (value: bigint) =>
  zap.encrypt(value, { accountAddress: user.account.address, dappAddress: vault, handleType: handleTypes.euint256 });
const [budgetCiphertext, perCallCapCiphertext] = (await Promise.all([encrypt(100_000n), encrypt(100_000n)])) as [Hex, Hex];
const { request: open, result: goalId } = await pub.simulateContract({
  address: vault,
  abi: stack.vaultAbi,
  functionName: "openGoal",
  account: user.account,
  value: 2n * (await stack.incoFee()),
  args: [
    {
      budgetCiphertext,
      perCallCapCiphertext,
      callsRemaining: 1,
      maxAttempts: 2,
      payer,
      relay: relay.relayAddress,
      asset: USDC,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 2 * 86_400),
      allowlist: [vendorAddress],
    },
  ],
});
await pub.waitForTransactionReceipt({ hash: await userWallet.writeContract(open) });
await stack.sendUsdc(payer, 50_000n);

const silent: EscrowGateway = {
  settle: (payment, requirements) => stack.gateway.settle(payment, requirements),
  claim: async () => ({ ok: false, reason: "this vendor has gone silent" }),
};
const silentVendor = await startMockApi(0, { escrow: stack.vendorOptions(silent) });
const unpaid = await new PaymentLoop({
  client: new X402Client({ retry: { maxAttempts: 2, baseDelayMs: 50 } }),
  relay,
  decisions: { read: async (handle: Hex) => ({ approved: true, signatures: [forkAttestation(handle, true)] }) },
  signer,
  agent: new ScriptedAgent(),
  asset: USDC,
  escrow: { vault, network: `eip155:${CHAIN_ID}` },
  reclaimWaitMs: 0,
}).fetchPaid(`${silentVendor.url}/resource/market-data`, goalId, { fresh: true });
const held = async () => (await paymentState(pub, vault, goalId, 1n)).held;
check("the run failed with the money held", unpaid.kind === "failed" && (await held()) === 10_000n);

await pub.waitForTransactionReceipt({
  hash: await userWallet.writeContract({ address: vault, abi: stack.vaultAbi, functionName: "closeGoal", args: [goalId] }),
});
check("sweep --execute returns the payer's balance", await script("sweep", ["--execute"]));
check("the held 0.01 did not come back with it", (await balance(user.account.address)) === before + 40_000n);

// Past the capture deadline, the vendor's 60 s hold plus 300 s, and no further. The signer
// signs a sweep for an hour by its own clock, which does not move when this one does.
await request("evm_increaseTime", [400]);
await request("evm_mine", []);
check("reclaim --execute finds it on the closed goal", await script("reclaim", ["--execute"]));
check("the escrow no longer holds it", (await held()) === 0n);
check("sweep --execute returns the rest", await script("sweep", ["--execute"]));
check("the payer is empty", (await balance(payer)) === 0n);
check("the owner has all of it", (await balance(user.account.address)) === before + 50_000n);
check("the vendor got nothing", (await balance(vendorAddress)) === vendorBefore);

await silentVendor.close();
await stack.close();
rmSync(benchDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nEvery script and check held.\n" : `\n${failures} check(s) FAILED.\n`);
// Set, not process.exit: see reclaim.ts.
process.exitCode = failures === 0 ? 0 : 1;
