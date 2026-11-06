/**
 * The whole escrow flow against real contracts, on a local fork. Nothing here touches a
 * real network: every transaction goes to the fork.
 *
 *   anvil --fork-url https://sepolia.base.org --port 8599
 *   forge build --root contracts
 *   ESCROW_ANVIL_RPC=http://127.0.0.1:8599 pnpm --filter @ntux402/e2e run escrow-flow
 *
 * Real: EscrowPolicyVault, Inco's on-chain contract, the deployed escrow, collector and
 * USDC, the signer, the facilitator with @x402/evm, the vendor, the relay and the payment
 * loop, each over its own HTTP surface where it has one.
 *
 * Not real: Inco's off-chain evaluation. A fork has no covalidators, so the decision comes
 * from this script and Inco's verifier is replaced to accept it. So this says nothing about
 * the encrypted limits, or that a decision was earned. It says everything else in the flow
 * holds together, and the policy itself is tested in the vault's Foundry suite.
 */

import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { handleTypes } from "@inco/lightning-js";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { AuthCaptureFacilitator, Facilitator, createFacilitatorServer } from "@ntux402/facilitator";
import {
  ChainEscrowGateway,
  HttpFacilitatorGateway,
  startMockApi,
  type EscrowGateway,
  type EscrowVendorOptions,
} from "@ntux402/mock-api";
import {
  ScriptedAgent,
  connectLightning,
  PaymentLoop,
  SignerClient,
  VaultRelay,
  X402Client,
} from "@ntux402/orchestrator";
import {
  AUTH_CAPTURE_ESCROW,
  ERC3009_TOKEN_COLLECTOR,
  USDC_BASE_SEPOLIA,
  escrowPolicyVaultAbi,
  networkForChainId,
} from "@ntux402/shared";
import { InMemoryKeyStore, OnChainVaultReader, createSignerServer, openSigner } from "@ntux402/signer";

const RPC = process.env["ESCROW_ANVIL_RPC"];
if (!RPC) {
  console.error("Set ESCROW_ANVIL_RPC to a local fork of Base Sepolia. See the top of this file.");
  process.exit(1);
}

const CHAIN_ID = 84532;
const USDC = USDC_BASE_SEPOLIA as Address;
const INCO: Address = "0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624";
/** Holds test USDC on the forked chain. */
const HOLDER: Address = "0x1111111111111111111111111111111111111111";
/** Returns true to anything: `PUSH1 1 PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN`. */
const ALWAYS_TRUE: Hex = "0x600160005260206000f3";
const PRICE = 10_000n; // market-data, 0.01 USDC

const chain = { ...baseSepolia, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const rpc = (method: string, params: unknown[]) => pub.request({ method, params } as never);

const erc20 = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const balance = (who: Address) =>
  pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [who] });

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const funded = async () => {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await rpc("anvil_setBalance", [account.address, toHex(10n ** 18n)]);
  return { key, account };
};

// ------------------------------------------------------------------ the chain

console.log("\nsetting up on the fork");
const user = await funded();
const relayKey = await funded();
const settler = await funded();
const vendorKey = await funded();

// Before the verifier is replaced: the SDK reads the network's public key from it.
const network = networkForChainId(CHAIN_ID)!;
const zap = await connectLightning(network, RPC);

const incoAbi = parseAbi(["function incoVerifier() view returns (address)", "function getFee() view returns (uint256)"]);
const verifier = await pub.readContract({ address: INCO, abi: incoAbi, functionName: "incoVerifier" });
await rpc("anvil_setCode", [verifier, ALWAYS_TRUE]);
console.log(`  replaced Inco's verifier ${verifier}: this run does not test decisions`);

const artifact = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../contracts/out/EscrowPolicyVault.sol/EscrowPolicyVault.json", import.meta.url)),
    "utf8",
  ),
) as { bytecode: { object: Hex } };
const userWallet = createWalletClient({ chain, transport: http(RPC), account: user.account });
const deployed = await pub.waitForTransactionReceipt({
  hash: await userWallet.deployContract({
    abi: escrowPolicyVaultAbi,
    bytecode: artifact.bytecode.object,
    args: [AUTH_CAPTURE_ESCROW, ERC3009_TOKEN_COLLECTOR],
  }),
});
const vault = deployed.contractAddress!;
console.log(`  EscrowPolicyVault ${vault}`);

// --------------------------------------------------------------- the services

async function listening(server: import("node:http").Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const signerService = await openSigner({
  settlement: "escrow",
  vault: new OnChainVaultReader({ rpcUrl: RPC, vaultAddress: vault, chainId: CHAIN_ID }),
  keys: new InMemoryKeyStore(),
  chainId: CHAIN_ID,
  usdcAddress: USDC,
  vaultAddress: vault,
});
const signerServer = createSignerServer({ signer: signerService });
const signer = new SignerClient(await listening(signerServer));

const facilitatorServer = createFacilitatorServer({
  facilitator: new Facilitator({
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    asset: USDC,
    network: "base-sepolia",
    settlerKey: settler.key,
  }),
  network: "base-sepolia",
  authCapture: new AuthCaptureFacilitator({
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    asset: USDC,
    settlerKey: settler.key,
    operators: [vault],
  }),
});
const facilitatorUrl = await listening(facilitatorServer);

const chainGateway = new ChainEscrowGateway({
  facilitator: new HttpFacilitatorGateway(facilitatorUrl),
  rpcUrl: RPC,
  chainId: CHAIN_ID,
  vault,
  vendorKey: vendorKey.key,
});
const vendorAddress = chainGateway.vendor;
const vendorOptions = (gateway: EscrowGateway): EscrowVendorOptions => ({
  vault,
  vendor: vendorAddress,
  network: `eip155:${CHAIN_ID}`,
  asset: USDC,
  maxTimeoutSeconds: 60,
  gateway,
});
const vendor = await startMockApi(0, { escrow: vendorOptions(chainGateway) });

const relay = new VaultRelay({ rpcUrl: RPC, vaultAddress: vault, relayKey: relayKey.key, chainId: CHAIN_ID });

let approve = true;
const decisions = { read: async () => ({ approved: approve, signatures: [`0x${"33".repeat(65)}` as Hex] }) };
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
  const fee = await pub.readContract({ address: INCO, abi: incoAbi, functionName: "getFee" });

  const { request, result } = await pub.simulateContract({
    address: vault,
    abi: escrowPolicyVaultAbi,
    functionName: "openGoal",
    account: user.account,
    value: 2n * fee,
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
  await rpc("anvil_impersonateAccount", [HOLDER]);
  await rpc("anvil_setBalance", [HOLDER, toHex(10n ** 18n)]);
  const holder = createWalletClient({ chain, transport: http(RPC), account: HOLDER });
  await pub.waitForTransactionReceipt({
    hash: await holder.writeContract({ address: USDC, abi: erc20, functionName: "transfer", args: [payer, 1_000_000n] }),
  });
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
const url = `${vendor.url}/resource/market-data`;
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
  const payment = sweep.value.payment!;
  const info = {
    operator: payment.operator,
    payer: payment.payer,
    receiver: payment.receiver,
    token: payment.token,
    maxAmount: BigInt(payment.maxAmount),
    preApprovalExpiry: payment.preApprovalExpiry,
    authorizationExpiry: payment.authorizationExpiry,
    refundExpiry: payment.refundExpiry,
    minFeeBps: 0,
    maxFeeBps: 0,
    feeReceiver: "0x0000000000000000000000000000000000000000" as Address,
    salt: BigInt(payment.salt),
  };
  const anyone = createWalletClient({ chain, transport: http(RPC), account: settler.account });
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
  settle: (payment, requirements) => chainGateway.settle(payment, requirements),
  claim: async () => ({ ok: false, reason: "this vendor has gone silent" }),
};
const silentVendor = await startMockApi(0, { escrow: vendorOptions(silent) });
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

await Promise.all([vendor.close(), silentVendor.close()]);
for (const server of [signerServer, facilitatorServer]) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

console.log(failures === 0 ? "\nEvery check held.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
