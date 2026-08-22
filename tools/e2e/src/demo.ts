/**
 * The whole demo, end to end, against Base Sepolia.
 *
 *   pnpm --filter @ntux402/e2e run demo
 *
 * Run 1 — honest 402:    approve, settle, data returns, USDC moves.
 * Run 2 — overcharge:    a plausible price, quietly over the encrypted budget.
 *                        The agent agrees to it. The money does not move.
 *
 * Prerequisites, all checked before anything is sent:
 *   - PolicyVault deployed, POLICY_VAULT_ADDRESS set
 *   - the signer, the facilitator and the mock API running
 *   - the user key funded with Base Sepolia ETH; the payer funded with USDC
 *
 * ## Which key plays which role — the point of the exercise
 *
 * This script stands in for the *user*: it opens the goal and funds the payer,
 * both of which MetaMask does in the real demo (IMPLEMENTATION.md §5). It never touches
 * the payer key, which lives only in the signer, and it never signs an EIP-3009
 * authorization. The orchestrator it drives holds the relay key and nothing
 * else. M2b's single-key script was fine for a latency measurement; this is the
 * separated version.
 */

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Lightning } from "@inco/lightning-js/lite";
import { handleTypes } from "@inco/lightning-js";
import { rpcTransport } from "@ntux402/shared/viem";
import { DEMO_PAYEES, formatUsdc, rpcUrls, usdcAbi } from "@ntux402/shared";
import {
  IncoDecisionReader,
  PaymentLoop,
  ScriptedAgent,
  SignerClient,
  VaultRelay,
  X402Client,
  buildAgent,
  llmConfigured,
  renderEvent,
  type PaymentResult,
} from "@ntux402/orchestrator";

/** Which mock endpoint a run targets. */
type Mode = "honest" | "malicious";

import {
  BASE_SEPOLIA_CHAIN_ID,
  INCO_FEE_ABI,
  INCO_SINGLETON,
  fmt,
  loadDotEnv,
  ms,
  now,
  optional,
  policyVaultAbi,
  required,
  requiredAddress,
  requiredHexKey,
} from "./config.js";

loadDotEnv();

// --- the policy under test -------------------------------------------------
// The honest call is 0.01 USDC; run 2 asks 0.35. Every public precondition
// clears — the price is far under the 6.00 cap, the payee is allowlisted, the
// description is ordinary prose — so the only thing left that can refuse it is
// the encrypted budget. That is the whole point, and it is why run 2 is the
// *overcharge* goal rather than the injection one.
//
// Run 2 used to be `premium-feed`: 5.00 plus a prompt injection. It stopped
// demonstrating anything the day the model got good enough to notice. On
// 2026-08-22 qwen3.7-flash read the injection, called it "a clearly deceptive
// billing notice" and declined — so the agent never called requestSpend and the
// vault was never asked. A demo that depends on the model being fooled is a
// demo with a coin flip in it. This one depends on the model being *convinced*,
// which is the easy direction, and on the budget refusing anyway.
const BUDGET = 200_000n; // 0.20 USDC, encrypted
const PER_CALL_CAP = 6_000_000n; // 6.00 USDC, public — deliberately above run 2's price
const CALLS_REMAINING = 5;
/**
 * Above the encrypted budget so Inco binds first (ARCHITECTURE.md §5.5), and
 * above run 2's 0.35 ask so a skeptic cannot say the payer simply could not
 * afford it. The refusal has to be the budget and nothing else.
 */
const PAYER_FUNDING = 450_000n; // 0.45 USDC



const rpcUrl = required("BASE_SEPOLIA_RPC_URL");
const vaultAddress = requiredAddress("POLICY_VAULT_ADDRESS");
const usdcAddress = requiredAddress("USDC_ADDRESS");
const signerUrl = optional("SIGNER_URL") ?? `http://127.0.0.1:${process.env["SIGNER_PORT"] ?? 8402}`;
const mockApiUrl = optional("MOCK_API_URL") ?? `http://127.0.0.1:${process.env["MOCK_API_PORT"] ?? 4021}`;

const user = privateKeyToAccount(requiredHexKey("DEPLOYER_PRIVATE_KEY"));
const relayKey = requiredHexKey("ORCHESTRATOR_RELAY_KEY");
const relayAddress = privateKeyToAccount(relayKey).address;

const publicClient = createPublicClient({ chain: baseSepolia, transport: rpcTransport(rpcUrl) });
const userWallet = createWalletClient({ account: user, chain: baseSepolia, transport: rpcTransport(rpcUrl) });
const abi = policyVaultAbi();

const rule = (label = "") =>
  console.log(`\n${label ? `--- ${label} ` : ""}${"-".repeat(Math.max(0, 62 - label.length))}\n`);

// ---------------------------------------------------------------- preflight
rule("preflight");

const chainId = await publicClient.getChainId();
if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
  throw new Error(`Wrong chain: ${chainId}, expected ${BASE_SEPOLIA_CHAIN_ID}`);
}
console.log(`  chain      ${chainId}`);
console.log(`  vault      ${vaultAddress}`);
console.log(`  user       ${user.address}  ${formatEther(await publicClient.getBalance({ address: user.address }))} ETH`);
console.log(`  relay      ${relayAddress}  ${formatEther(await publicClient.getBalance({ address: relayAddress }))} ETH  (gas only)`);

for (const [label, url] of [
  ["signer", `${signerUrl}/health`],
  ["mock-api", `${mockApiUrl}/health`],
] as const) {
  const response = await fetch(url).catch(() => undefined);
  if (!response?.ok) throw new Error(`${label} is not reachable at ${url}. Start it first.`);
  console.log(`  ${label.padEnd(10)} up at ${url.replace("/health", "")}`);
}

const facilitatorUrl = optional("X402_FACILITATOR_URL");
if (facilitatorUrl) {
  const health = await fetch(`${facilitatorUrl}/health`).catch(() => undefined);
  if (!health?.ok) throw new Error(`facilitator is not reachable at ${facilitatorUrl}`);
  console.log(`  facilitator up at ${facilitatorUrl}  -> USDC will actually move`);
} else {
  console.log(`  facilitator NOT configured  -> stub settlement, no money moves`);
}

// --------------------------------------------------------- mint the payer
// Before openGoal, because the payer address is a field of the goal record
// (ARCHITECTURE.md §5.3). Doing it afterwards would need a mutable payer field, and a
// mutable payer field lets whoever can write it redirect every signature.
rule("1. mint the ephemeral payer key");

const signer = new SignerClient(signerUrl, undefined, optional("SERVICE_TOKEN"));
const payer = await signer.mintPayer();
console.log(`  payer      ${payer}`);
console.log(`  The signer generated this key and returned only the address.`);
console.log(`  Nothing else in the system can produce a signature for it.`);

// ------------------------------------------------------------- open the goal
rule("2. open the goal — the user's own transaction");

const zap = await Lightning.baseSepoliaTestnet({ hostChainRpcUrls: [...rpcUrls(rpcUrl)] });

let t = now();
const budgetCiphertext = (await zap.encrypt(BUDGET, {
  accountAddress: user.address,
  dappAddress: vaultAddress,
  handleType: handleTypes.euint256,
})) as Hex;
console.log(`  encrypted the budget client-side in ${fmt(ms(t))}`);
console.log(`  (in the browser this is the identical call — only the wallet differs)`);

const incoFee = (await publicClient.readContract({
  address: INCO_SINGLETON,
  abi: INCO_FEE_ABI,
  functionName: "getFee",
})) as bigint;

t = now();
const openHash = await userWallet.writeContract({
  address: vaultAddress,
  abi,
  functionName: "openGoal",
  args: [
    {
      budgetCiphertext,
      perCallCap: PER_CALL_CAP,
      callsRemaining: CALLS_REMAINING,
      payer,
      relay: relayAddress,
      asset: usdcAddress,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600),
      allowlist: [...DEMO_PAYEES],
    },
  ],
  value: incoFee,
});
const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });
const opened = parseEventLogs({ abi, eventName: "GoalOpened", logs: openReceipt.logs })[0];
if (!opened) throw new Error("GoalOpened not emitted");
const { goalId, budgetHandle } = opened.args as { goalId: bigint; budgetHandle: Hex };

console.log(`  openGoal confirmed in ${fmt(ms(t))}  gas ${openReceipt.gasUsed}`);
console.log(`  goalId        ${goalId}`);
console.log(`  budget handle ${budgetHandle}`);
console.log(`  budget        ${formatUsdc(BUDGET)} USDC — encrypted; the handle above reveals nothing`);
console.log(`  perCallCap    ${formatUsdc(PER_CALL_CAP)} USDC — public, and deliberately ABOVE the`);
console.log(`                malicious price, so the bounce comes from Inco and not from a require()`);
console.log(`\n  Basescan: https://sepolia.basescan.org/address/${vaultAddress}`);

// Every mock payee is allowlisted on purpose: run 2 must fail the *confidential*
// check, not a public precondition. A PayeeNotAllowlisted revert would prove
// nothing about the budget — it is the vault refusing on a public rule, which is
// the thing this demo exists to distinguish itself from.
//
// Taken from the catalog rather than listed here. The two addresses this file
// used to hardcode were the payees of the two goals it happened to buy, so
// pointing run 2 at a third goal reverted with PayeeNotAllowlisted — a config
// gap that reads exactly like a policy decision at a glance.

// ------------------------------------------------------------- fund the payer
rule("3. fund the ephemeral payer");

const userUsdc = (await publicClient.readContract({
  address: usdcAddress,
  abi: usdcAbi,
  functionName: "balanceOf",
  args: [user.address],
})) as bigint;

/** Drives the expected baseline below: false means the payer stays at zero. */
let fundedPayer: boolean;

if (userUsdc < PAYER_FUNDING) {
  const shortfall =
    `The user account holds ${formatUsdc(userUsdc)} USDC, needs ${formatUsdc(PAYER_FUNDING)}. ` +
    `Faucet: https://faucet.circle.com (select Base Sepolia).`;
  // Only fatal when settlement is live. Without a facilitator nothing submits
  // `transferWithAuthorization`, so an unfunded payer still exercises the whole
  // control flow — including the bounce, which never needed USDC anyway.
  if (facilitatorUrl) throw new Error(shortfall);
  console.log(`  SKIPPED — ${shortfall}`);
  console.log(`  Settlement is stubbed, so the run still exercises the full control flow;`);
  console.log(`  it just does not move real money. Fund the account to see that part.`);
  fundedPayer = false;
} else {
  const fundHash = await userWallet.writeContract({
    address: usdcAddress,
    abi: usdcAbi,
    functionName: "transfer",
    args: [payer, PAYER_FUNDING],
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log(`  sent ${formatUsdc(PAYER_FUNDING)} USDC to ${payer}`);
  console.log(`  Deliberately more than the ${formatUsdc(BUDGET)} USDC encrypted budget. Two independent`);
  console.log(`  bounds: even if the Inco policy were bypassed entirely, the ceiling is what was funded.`);
  fundedPayer = true;
}

// The payer is freshly minted, so its balance before funding is zero. Confirm
// the transfer is actually visible before using it as a baseline — the receipt
// alone is not enough on a load-balanced RPC, and a stale baseline is what made
// the first version of this script misreport which run spent the money.
const payerStartingBalance = await awaitBalance(fundedPayer ? PAYER_FUNDING : 0n);
if (fundedPayer && payerStartingBalance !== PAYER_FUNDING) {
  throw new Error(
    `Funded ${formatUsdc(PAYER_FUNDING)} USDC but the chain still reports ` +
      `${formatUsdc(payerStartingBalance)} after 60s. Aborting rather than reporting nonsense.`,
  );
}
console.log(`  payer balance confirmed at ${formatUsdc(payerStartingBalance)} USDC`);

// --------------------------------------------------------------- the agent
rule("4. hand off to the orchestrator");

const relay = new VaultRelay({ rpcUrl, vaultAddress, relayKey, chainId: BASE_SEPOLIA_CHAIN_ID });
const agentKey = optional("AISA_INFERENCE_KEY");
const agentModel = optional("LLM_MODEL");
const agent = await buildAgent({
  apiKey: agentKey,
  model: agentModel,
  baseUrl: optional("AISA_API_BASE_URL"),
  fallback: new ScriptedAgent(),
  onFallback: (detail) =>
    console.warn(`  model gateway did not answer — scripted stand-in decided: ${detail}`),
});
console.log(
  llmConfigured({ apiKey: agentKey, model: agentModel })
    ? `  agent: live LLM (${agentModel})`
    : `  agent: scripted stand-in (set AISA_INFERENCE_KEY and LLM_MODEL for a live model)`,
);
console.log(`  From here on there are no wallet prompts. That is the product.`);

const loop = new PaymentLoop({
  client: new X402Client(),
  relay,
  decisions: new IncoDecisionReader(zap),
  signer,
  agent,
  asset: usdcAddress,
  onEvent: (event) => console.log(renderEvent(event)),
});

async function payerBalance(): Promise<bigint> {
  return (await publicClient.readContract({
    address: usdcAddress,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [payer],
  })) as bigint;
}

/**
 * Waits for the payer's balance to equal `expected`.
 *
 * Public RPCs are load-balanced, and a transfer's receipt can be in hand before
 * the node answering the next read has the block. Naively diffing balances
 * across a run therefore attributes a *previous* transfer to the *current* run
 * — which on this demo made the honest run's payment look like it came from the
 * malicious one, inverting the whole point.
 *
 * Waiting for a value we can predict, rather than for "something changed",
 * removes the ambiguity: we know what each step should cost, so we assert it.
 */
async function awaitBalance(expected: bigint, timeoutMs = 60_000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let balance = await payerBalance();
  while (balance !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    balance = await payerBalance();
  }
  return balance;
}

/**
 * Which catalog entry each run buys.
 *
 * `honest` stays on the legacy alias, which the mock maps to `market-data`.
 * Run 2 names `compliance-audit` outright rather than going through the
 * `malicious` alias — that alias points at `premium-feed`, is pinned by the
 * README and by mock-api's own tests, and means "the injection one" to every
 * other reader. Repointing it would have quietly changed a documented URL.
 */
const RESOURCE: Readonly<Record<Mode, string>> = {
  honest: "honest",
  malicious: "compliance-audit",
};

/** Runs one request and reports what it actually cost, against a known baseline. */
async function runAndReport(label: Mode, baseline: bigint): Promise<[PaymentResult, bigint]> {
  const result = await loop.fetchPaid(`${mockApiUrl}/resource/${RESOURCE[label]}`, goalId);

  // What the balance *should* be, derived from the outcome rather than observed.
  const paidAmount =
    result.kind === "paid" && result.settlement?.simulated !== true ? result.terms.amount : 0n;
  const expected = baseline - paidAmount;

  const actual = await awaitBalance(expected);

  console.log(`\n  outcome        ${result.kind}`);
  console.log(
    `  payer balance  ${formatUsdc(baseline)} -> ${formatUsdc(actual)} USDC  ` +
      `(moved ${formatUsdc(baseline - actual)})`,
  );
  if (actual !== expected) {
    console.log(
      `  NOTE: expected ${formatUsdc(expected)} USDC but the chain reports ${formatUsdc(actual)} ` +
        `after 60s. Investigate before trusting this run.`,
    );
  } else if (paidAmount === 0n) {
    console.log(`  Nothing moved, as expected — and confirmed against the chain, not assumed.`);
  }
  return [result, actual];
}

// ------------------------------------------------------------------- run 1
rule("RUN 1 — honest 402");
const [honest, afterHonest] = await runAndReport("honest", payerStartingBalance);

// ------------------------------------------------------------------- run 2
rule("RUN 2 — overcharge 402 (plausible price, over the encrypted budget)");
const [malicious] = await runAndReport("malicious", afterHonest);

// ------------------------------------------------------------------ verdict
rule("verdict");

const goal = await relay.goal(goalId);
const finalHandle = (await publicClient.readContract({
  address: vaultAddress,
  abi,
  functionName: "remainingBudgetHandle",
  args: [goalId],
})) as Hex;

console.log(`  run 1 (honest)     ${honest.kind}`);
console.log(`  run 2 (malicious)  ${malicious.kind}`);
console.log(`  callsRemaining     ${goal.callsRemaining} of ${CALLS_REMAINING}`);
console.log(`  budget handle      ${finalHandle}`);
console.log(`    (still opaque, and a different handle than at open — every debit mints a new one)`);

const injectionWorked = malicious.kind === "policy-rejected";
const honestWorked = honest.kind === "paid";

if (honestWorked && injectionWorked) {
  console.log(`\n  The agent was successfully manipulated and the money still did not move —`);
  console.log(`  because the component that decides never reads the attacker's text, and the`);
  console.log(`  component that signs only reads the chain.\n`);
  process.exit(0);
}

console.log(`\n  NOT the expected demo outcome.`);
if (!honestWorked) console.log(`    run 1 should have been "paid", got "${honest.kind}"`);
if (!injectionWorked) console.log(`    run 2 should have been "policy-rejected", got "${malicious.kind}"`);
console.log();
process.exit(1);
