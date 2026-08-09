/**
 * M2b — one real goal against Base Sepolia, instrumented.
 *
 *   openGoal -> requestSpend -> poll attestedReveal -> finalizeDecision
 *
 * The deliverable is not the transactions, it is the **reveal latency**: how
 * long after `requestSpend` confirms before `zap.attestedReveal([handle])`
 * first returns. That number is undocumented (register item 3) and every
 * timing assumption in the demo depends on it.
 *
 * Polling is bounded and the timeout is surfaced rather than slept through.
 *
 *   pnpm --filter @ntux402/e2e run m2b
 *
 * Roles: this script plays user, relay and finalizer with one key. That is fine
 * for a latency measurement and wrong for the demo — in M6 the user is
 * MetaMask and the relay is the orchestrator.
 */

import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEventLogs,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Lightning } from "@inco/lightning-js/lite";
import { handleTypes } from "@inco/lightning-js";

import {
  BASE_SEPOLIA_CHAIN_ID,
  USDC_BASE_SEPOLIA,
  fmt,
  loadDotEnv,
  ms,
  now,
  policyVaultAbi,
  required,
  requiredAddress,
  requiredHexKey,
} from "./config.js";

loadDotEnv();

// --- policy under test ----------------------------------------------------
const BUDGET = 300_000n; // 0.30 USDC (6 decimals)
const PER_CALL_CAP = 200_000n; // 0.20 USDC
const CALLS_REMAINING = 5;
const SPEND_AMOUNT = 50_000n; // 0.05 USDC — in policy, should approve
const VENDOR = "0x1111111111111111111111111111111111111111" as const;
const RESOURCE = "https://api.example.com/resource/honest";

// --- reveal polling -------------------------------------------------------
const REVEAL_TIMEOUT_MS = 180_000;
const REVEAL_POLL_INTERVAL_MS = 1_000;

const rpcUrl = required("BASE_SEPOLIA_RPC_URL");
const vaultAddress = requiredAddress("POLICY_VAULT_ADDRESS");
const account = privateKeyToAccount(requiredHexKey("DEPLOYER_PRIVATE_KEY"));
const abi = policyVaultAbi();

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });

/**
 * Public RPCs are load-balanced, so the node answering the next gas estimate may
 * not yet have the block a receipt just came from — the write then reverts with
 * `UnknownGoal` against state that demonstrably exists. Wait for the write to be
 * readable before building the next one, bounded and surfaced on timeout.
 */
async function waitUntilVisible(
  label: string,
  read: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<number> {
  const started = now();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await read()) return ms(started);
    } catch {
      /* node not ready; retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} not visible after ${timeoutMs}ms — RPC propagation exceeded the wait.`);
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const timings: Array<{ step: string; detail: string; elapsed: number }> = [];
const record = (step: string, elapsed: number, detail = "") => {
  timings.push({ step, detail, elapsed });
  console.log(`  ${fmt(elapsed).padStart(8)}  ${step}${detail ? `  ${detail}` : ""}`);
};

// Never infer the chain from the wallet — assert it before every write.
const chainId = await publicClient.getChainId();
if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
  throw new Error(`Wrong chain: ${chainId}, expected ${BASE_SEPOLIA_CHAIN_ID}`);
}

console.log("\nM2b — one real goal on Base Sepolia\n");
console.log(`  vault    ${vaultAddress}`);
console.log(`  account  ${account.address}`);
console.log(`  balance  ${formatEther(await publicClient.getBalance({ address: account.address }))} ETH\n`);

// --------------------------------------------------------------- Inco setup
let t = now();
const zap = await Lightning.baseSepoliaTestnet({ hostChainRpcUrls: [rpcUrl] });
record("Lightning SDK init", ms(t));

// ------------------------------------------------------- client encryption
// The ciphertext is bound to (accountAddress, dappAddress). In the browser this
// is the identical call — only the wallet differs.
t = now();
const budgetCiphertext = (await zap.encrypt(BUDGET, {
  accountAddress: account.address,
  dappAddress: vaultAddress,
  handleType: handleTypes.euint256,
})) as Hex;
record("encrypt budget (client)", ms(t), `${budgetCiphertext.length} hex chars`);

// ------------------------------------------------------------------ fee
const incoFee = await publicClient.readContract({
  address: "0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624",
  abi: [{ type: "function", name: "getFee", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }],
  functionName: "getFee",
});

// -------------------------------------------------------------- openGoal
t = now();
const openHash = await walletClient.writeContract({
  address: vaultAddress,
  abi,
  functionName: "openGoal",
  args: [
    {
      budgetCiphertext,
      perCallCap: PER_CALL_CAP,
      callsRemaining: CALLS_REMAINING,
      payer: account.address, // M3 replaces this with the ephemeral payer
      relay: account.address,
      asset: USDC_BASE_SEPOLIA,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600),
      allowlist: [VENDOR],
    },
  ],
  value: incoFee,
});
const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });
record("openGoal confirmed", ms(t), `gas ${openReceipt.gasUsed}  ${openHash}`);

const openedLogs = parseEventLogs({ abi, eventName: "GoalOpened", logs: openReceipt.logs });
const goalId = (openedLogs[0]?.args as { goalId: bigint } | undefined)?.goalId;
if (goalId === undefined) throw new Error("GoalOpened not emitted — cannot continue");
const budgetHandle = (openedLogs[0]!.args as { budgetHandle: Hex }).budgetHandle;
console.log(`\n  goalId        ${goalId}`);
console.log(`  budget handle ${budgetHandle}   <- opaque bytes32, reveals nothing\n`);

const goalLag = await waitUntilVisible(`Goal ${goalId}`, async () => {
  const goal = (await publicClient.readContract({
    address: vaultAddress,
    abi,
    functionName: "goals",
    args: [goalId],
  })) as readonly unknown[];
  return (goal[0] as string).toLowerCase() !== ZERO_ADDRESS;
});
record("goal readable across RPC", goalLag);

// ------------------------------------------------------------ requestSpend
t = now();
const spendHash = await walletClient.writeContract({
  address: vaultAddress,
  abi,
  functionName: "requestSpend",
  args: [goalId, SPEND_AMOUNT, VENDOR, RESOURCE],
});
const spendReceipt = await publicClient.waitForTransactionReceipt({ hash: spendHash });
const spendConfirmedAt = now();
record("requestSpend confirmed", ms(t), `gas ${spendReceipt.gasUsed}  ${spendHash}`);

const spendLogs = parseEventLogs({ abi, eventName: "SpendRequested", logs: spendReceipt.logs });
const spendArgs = spendLogs[0]?.args as
  | { seq: bigint; decisionHandle: Hex; termsHash: Hex; validAfter: bigint; validBefore: bigint }
  | undefined;
if (!spendArgs) throw new Error("SpendRequested not emitted — cannot continue");

console.log(`\n  seq             ${spendArgs.seq}`);
console.log(`  decision handle ${spendArgs.decisionHandle}`);
console.log(`  termsHash       ${spendArgs.termsHash}`);
console.log(`  validity window ${spendArgs.validAfter} .. ${spendArgs.validBefore}  (frozen)\n`);

// ----------------------------------------------- poll attestedReveal (item 3)
// The measurement M2b exists for. Bounded, and the timeout is reported rather
// than swallowed — a hardcoded sleep here would hide exactly what we came for.
console.log("  polling zap.attestedReveal(...) — this is the number that matters");

let attestation: Awaited<ReturnType<typeof zap.attestedReveal>>[number] | undefined;
let attempts = 0;
let revealLatency = 0;
const deadline = Date.now() + REVEAL_TIMEOUT_MS;

while (Date.now() < deadline) {
  attempts++;
  try {
    const results = await zap.attestedReveal([spendArgs.decisionHandle]);
    if (results.length > 0) {
      attestation = results[0];
      revealLatency = ms(spendConfirmedAt);
      break;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (attempts === 1 || attempts % 10 === 0) {
      console.log(`      attempt ${attempts}: not ready (${message.slice(0, 90)})`);
    }
  }
  await new Promise((r) => setTimeout(r, REVEAL_POLL_INTERVAL_MS));
}

if (!attestation) {
  console.error(
    `\n  TIMEOUT after ${fmt(ms(spendConfirmedAt))} and ${attempts} attempts.\n` +
      `  The decision handle never became retrievable. This is register item 3 —\n` +
      `  report the timeout rather than assuming a longer sleep would fix it.\n`,
  );
  process.exit(1);
}

record("attestedReveal available", revealLatency, `after ${attempts} attempt(s)`);
const approved = Boolean(attestation.plaintext.value);
console.log(`\n  decision        ${approved ? "APPROVE" : "REJECT"}\n`);

// ------------------------------------------------------- finalizeDecision
await waitUntilVisible(`Spend record ${goalId}/${spendArgs.seq}`, async () => {
  const handle = (await publicClient.readContract({
    address: vaultAddress,
    abi,
    functionName: "decisionHandle",
    args: [goalId, spendArgs.seq],
  })) as Hex;
  return handle === spendArgs.decisionHandle;
});

// The SDK hands back `Uint8Array[]`; viem needs `0x…` strings to encode `bytes[]`.
const signatures = attestation.covalidatorSignatures.map((sig) => bytesToHex(sig));

t = now();
const finalizeHash = await walletClient.writeContract({
  address: vaultAddress,
  abi,
  functionName: "finalizeDecision",
  args: [goalId, spendArgs.seq, approved, signatures],
});
const finalizeReceipt = await publicClient.waitForTransactionReceipt({ hash: finalizeHash });
record("finalizeDecision confirmed", ms(t), `gas ${finalizeReceipt.gasUsed}  ${finalizeHash}`);

// ------------------------------------------------------------------ result
// Same propagation guard: read the settled state, not whatever a lagging node
// still has. Without this the summary reports a finalised spend as unapproved.
await waitUntilVisible(`Finalisation of ${goalId}/${spendArgs.seq}`, async () =>
  Boolean(
    await publicClient.readContract({
      address: vaultAddress,
      abi,
      functionName: "isFinalized",
      args: [goalId, spendArgs.seq],
    }),
  ),
);

const [isApproved, callsLeft, newBudgetHandle] = await Promise.all([
  publicClient.readContract({ address: vaultAddress, abi, functionName: "isApproved", args: [goalId, spendArgs.seq] }),
  publicClient.readContract({ address: vaultAddress, abi, functionName: "goals", args: [goalId] }),
  publicClient.readContract({ address: vaultAddress, abi, functionName: "remainingBudgetHandle", args: [goalId] }),
]);

console.log("\n--- measured -------------------------------------------------");
for (const row of timings) console.log(`  ${row.step.padEnd(28)} ${fmt(row.elapsed).padStart(9)}`);
console.log("--------------------------------------------------------------");
console.log(`\n  isApproved(goal,seq)  ${isApproved}`);
console.log(`  callsRemaining        ${(callsLeft as unknown[])[4]}`);
console.log(`  budget handle now     ${newBudgetHandle}`);
console.log(`    (differs from the open-time handle: every debit mints a new one)\n`);
console.log(`  Basescan: https://sepolia.basescan.org/address/${vaultAddress}\n`);
