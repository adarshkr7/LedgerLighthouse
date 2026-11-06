/**
 * Repeated measurements for the paper: latency of every stage and gas of every
 * transaction, over many paid calls and many rejected ones.
 *
 *   pnpm --filter @ntux402/e2e run bench                  30 approved, 20 rejected
 *   pnpm --filter @ntux402/e2e run bench -- --approved 50 --rejected 30
 *   pnpm --filter @ntux402/e2e run bench -- --out /some/dir
 *
 * ## What it runs
 *
 * One goal, then two phases on it, through exactly the path the demo uses:
 * `PaymentLoop`, the vault relay, Inco's attested reveal, the signer, the
 * facilitator and the mock seller, through the auth-capture escrow.
 *
 *   - approved: `market-data` at 0.01 USDC, under the cap and the budget, so
 *     each call commits, is approved, signed, settled and served.
 *   - rejected: `compliance-audit` at 0.35 USDC, over the 0.05 cap. Each
 *     commits and is rejected on chain. A rejection consumes neither budget nor
 *     calls, so the second phase does not disturb the first.
 *
 * The agent is the scripted one on purpose. A model's response time varies by
 * seconds with gateway load and would swamp the stages this measures; model
 * latency is a separate question and is reported separately.
 *
 * ## What it records
 *
 * Per call: wall time from first request to each stage, the reveal's own
 * latency and poll count, and the gas of `requestEscrowSpend`, `finalizeDecision`,
 * the vendor's hold and its claim, read from their receipts. Everything goes to
 * `docs/runs/bench-<date>.json` unless `--out` names another directory,
 * and a summary (median, mean, 10th and 90th percentile, min, max) is printed.
 * A call that ends in anything other than its expected outcome is recorded with
 * that outcome and excluded from the statistics, never silently dropped.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { handleTypes } from "@inco/lightning-js";
import { rpcTransport, sendingAccount, viemChain } from "@ntux402/shared/viem";
import { formatUsdc, usdcAbi } from "@ntux402/shared";
import {
  PaymentLoop,
  ScriptedAgent,
  SignerClient,
  VaultRelay,
  X402Client,
  connectLightning,
  type PaymentEvent,
} from "@ntux402/orchestrator";

import {
  INCO_FEE_ABI,
  INCO_SINGLETON,
  loadDotEnv,
  optional,
  requiredAddress,
  requiredHexKey,
  networkFromEnv,
  vaultAbi,
} from "./config.js";
import { assertEscrowSigner, assertEscrowVault, decisionSource, mockVendor } from "./escrow.js";

loadDotEnv();

// ---------------------------------------------------------------- arguments

function intArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} needs a non-negative integer`);
  return n;
}

const APPROVED = intArg("approved", 30);
const REJECTED = intArg("rejected", 20);

const PRICE_OK = 10_000n; // market-data, 0.01 USDC
const CAP = 50_000n; // 0.05: above market-data, below compliance-audit's 0.35
const BUDGET = PRICE_OK * BigInt(APPROVED) + 10_000n; // every approved call fits, with a margin
const FUNDING = BUDGET + 50_000n; // above the budget, so the policy binds first

// ---------------------------------------------------------------- setup

const { network, rpcUrl, usdcAddress } = networkFromEnv();
const vaultAddress = requiredAddress("POLICY_VAULT_ADDRESS");
const signerUrl = optional("SIGNER_URL") ?? `http://127.0.0.1:${process.env["SIGNER_PORT"] ?? 8402}`;
const mockApiUrl = optional("MOCK_API_URL") ?? `http://127.0.0.1:${process.env["MOCK_API_PORT"] ?? 4021}`;
if (!optional("X402_FACILITATOR_URL")) {
  throw new Error("X402_FACILITATOR_URL is not set: approved calls would not settle, and settlement is part of what is measured.");
}

const user = sendingAccount(requiredHexKey("DEPLOYER_PRIVATE_KEY"));
const relayKey = requiredHexKey("ORCHESTRATOR_RELAY_KEY");
const relayAddress = privateKeyToAccount(relayKey).address;
const publicClient = createPublicClient({ chain: viemChain(network), transport: rpcTransport(rpcUrl) });
const userWallet = createWalletClient({ account: user, chain: viemChain(network), transport: rpcTransport(rpcUrl) });
const abi = vaultAbi();

await assertEscrowVault(publicClient, vaultAddress);
await assertEscrowSigner(signerUrl, vaultAddress);
const vendor = await mockVendor(mockApiUrl, vaultAddress);

const signerHealth = await fetch(`${signerUrl}/health`).then((r) => r.json()).catch(() => undefined) as
  | { vault?: string; custody?: { store?: string } }
  | undefined;
if (!signerHealth) throw new Error(`signer is not reachable at ${signerUrl}`);
if (signerHealth.vault?.toLowerCase() !== vaultAddress.toLowerCase()) {
  throw new Error(`signer reads vault ${signerHealth.vault}, not ${vaultAddress}`);
}
const custody = signerHealth.custody?.store ?? "unknown";

console.log(`bench: ${APPROVED} approved + ${REJECTED} rejected calls`);
console.log(`  vault ${vaultAddress}\n  signer ${signerUrl} (key store: ${custody})`);

const signer = new SignerClient(signerUrl, undefined, optional("SIGNER_SERVICE_TOKEN") ?? optional("SERVICE_TOKEN"));
const payer = await signer.mintPayer();
const zap = await connectLightning(network, rpcUrl);
const encrypt = async (v: bigint) =>
  (await zap.encrypt(v, { accountAddress: user.address, dappAddress: vaultAddress, handleType: handleTypes.euint256 })) as Hex;

const incoFee = (await publicClient.readContract({ address: INCO_SINGLETON, abi: INCO_FEE_ABI, functionName: "getFee" })) as bigint;
const openHash = await userWallet.writeContract({
  address: vaultAddress,
  abi,
  functionName: "openGoal",
  args: [
    {
      budgetCiphertext: await encrypt(BUDGET),
      perCallCapCiphertext: await encrypt(CAP),
      // One more than the approved phase uses. With exactly APPROVED calls the
      // rejected phase met a call count of zero, which the vault rejects in
      // plaintext without the encrypted comparison, so it measured the wrong
      // path. Rejections spend no call, so one spare call serves them all.
      callsRemaining: APPROVED + 1,
      // Every request spends an attempt, approved or rejected.
      maxAttempts: APPROVED + REJECTED,
      payer,
      relay: relayAddress,
      asset: usdcAddress,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 24 * 3600),
      allowlist: [vendor],
    },
  ],
  value: 2n * incoFee,
});
const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });
const opened = parseEventLogs({ abi, eventName: "GoalOpened", logs: openReceipt.logs })[0];
if (!opened) throw new Error("GoalOpened not emitted");
const goalId = (opened.args as { goalId: bigint }).goalId;
console.log(`  goal ${goalId}  openGoal gas ${openReceipt.gasUsed}  payer ${payer}`);

const fundHash = await userWallet.writeContract({ address: usdcAddress, abi: usdcAbi, functionName: "transfer", args: [payer, FUNDING] });
await publicClient.waitForTransactionReceipt({ hash: fundHash });
// The next read may land on a node behind the receipt; wait for the funding to be visible.
for (let i = 0; i < 60; i++) {
  const b = (await publicClient.readContract({ address: usdcAddress, abi: usdcAbi, functionName: "balanceOf", args: [payer] })) as bigint;
  if (b === FUNDING) break;
  await new Promise((r) => setTimeout(r, 1_000));
}
console.log(`  funded ${formatUsdc(FUNDING)} USDC; budget ${formatUsdc(BUDGET)}, cap ${formatUsdc(CAP)} (both encrypted)`);

// ---------------------------------------------------------------- one call

interface CallRecord {
  readonly phase: "approved" | "rejected";
  readonly index: number;
  readonly outcome: string;
  readonly reason?: string | undefined;
  readonly expected: boolean;
  readonly seq?: string | undefined;
  /** Milliseconds from the first request of the call. */
  readonly t: Record<string, number>;
  readonly revealLatencyMs?: number | undefined;
  readonly revealAttempts?: number | undefined;
  readonly requestSpendGas?: string | undefined;
  readonly finalizeGas?: string | undefined;
  readonly commitTx?: string | undefined;
  readonly finalizeTx?: string | undefined;
  readonly settleTx?: string | undefined;
  readonly claimTx?: string | undefined;
  readonly holdGas?: string | undefined;
  readonly claimGas?: string | undefined;
}

let events: { at: number; event: PaymentEvent }[] = [];
const relay = new VaultRelay({ rpcUrl, vaultAddress, relayKey, chainId: network.chainId });
const decisions = await decisionSource(zap, publicClient, vaultAddress);
decisions.limits(goalId, BUDGET, CAP);
// A fresh loop, and so a fresh x402 client, per call: the client caches a paid
// response, which is right for an agent and would turn every repeat into a free
// cache hit here.
const newLoop = () =>
  new PaymentLoop({
    client: new X402Client(),
    relay,
    decisions,
    signer,
    agent: new ScriptedAgent(),
    asset: usdcAddress,
    escrow: { vault: vaultAddress, network: `eip155:${network.chainId}` },
    onEvent: (event) => events.push({ at: performance.now(), event }),
  });

async function receiptGas(hash: Hex | undefined): Promise<string | undefined> {
  if (!hash) return undefined;
  const r = await publicClient.waitForTransactionReceipt({ hash });
  return r.gasUsed.toString();
}

async function oneCall(phase: CallRecord["phase"], index: number): Promise<CallRecord> {
  events = [];
  const resource = phase === "approved" ? "market-data" : "compliance-audit";
  const start = performance.now();
  const result = await newLoop().fetchPaid(`${mockApiUrl}/resource/${resource}`, goalId);
  const end = performance.now();

  const t: Record<string, number> = {};
  const mark = (name: string, at: number) => {
    if (t[name] === undefined) t[name] = Math.round(at - start);
  };
  let revealLatencyMs: number | undefined;
  let revealAttempts: number | undefined;
  let seq: string | undefined;
  let commitTx: Hex | undefined;
  let finalizeTx: Hex | undefined;
  let requestSpendGas: string | undefined;
  let settleTx: Hex | undefined;
  let claimTx: Hex | undefined;
  for (const { at, event } of events) {
    switch (event.type) {
      case "payment-required": mark("402", at); break;
      case "agent-reasoning": mark("agent", at); break;
      case "spend-requested":
        mark("committed", at);
        seq = event.spend.seq.toString();
        commitTx = event.spend.commitTx;
        requestSpendGas = event.spend.gasUsed.toString();
        break;
      case "reveal-polled":
        mark("revealed", at);
        revealLatencyMs = event.latencyMs;
        revealAttempts = event.attempts;
        break;
      case "decision-finalized": mark("finalized", at); finalizeTx = event.txHash; break;
      case "signed": mark("signed", at); break;
      case "settled":
        mark("settled", at);
        settleTx = event.settlement.transaction;
        claimTx = event.settlement.claimTransaction;
        break;
      default: break;
    }
  }
  t["done"] = Math.round(end - start);

  const want = phase === "approved" ? "paid" : "policy-rejected";
  return {
    phase,
    index,
    outcome: result.kind,
    ...(result.kind === "failed" ? { reason: result.reason } : {}),
    expected: result.kind === want,
    ...(seq ? { seq } : {}),
    t,
    ...(revealLatencyMs !== undefined ? { revealLatencyMs, revealAttempts } : {}),
    ...(requestSpendGas ? { requestSpendGas } : {}),
    ...(finalizeTx ? { finalizeGas: await receiptGas(finalizeTx), finalizeTx } : {}),
    ...(commitTx ? { commitTx } : {}),
    ...(settleTx ? { settleTx, holdGas: await receiptGas(settleTx) } : {}),
    ...(claimTx ? { claimTx, claimGas: await receiptGas(claimTx) } : {}),
  };
}

// ---------------------------------------------------------------- run

const records: CallRecord[] = [];
const started = new Date();
for (const [phase, count] of [["approved", APPROVED], ["rejected", REJECTED]] as const) {
  for (let i = 1; i <= count; i++) {
    let record: CallRecord;
    try {
      record = await oneCall(phase, i);
    } catch (e) {
      record = { phase, index: i, outcome: `error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, expected: false, t: {} };
    }
    records.push(record);
    console.log(
      `  ${phase} ${String(i).padStart(3)}  ${record.outcome.padEnd(16)} ${String(record.t["done"] ?? "-").padStart(6)} ms` +
        (record.revealLatencyMs !== undefined ? `  reveal ${record.revealLatencyMs} ms (${record.revealAttempts})` : "") +
        (record.reason ? `  reason: ${record.reason.split("\n")[0]!.slice(0, 160)}` : ""),
    );
  }
}

// ---------------------------------------------------------------- summary

function stats(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  // Interpolates between neighbours, so the median of an even count is the mean
  // of its two middle values and not the upper one.
  const q = (p: number) => {
    const at = p * (v.length - 1);
    const below = Math.floor(at);
    const above = Math.ceil(at);
    return Math.round(v[below]! + (v[above]! - v[below]!) * (at - below));
  };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { n: v.length, median: q(0.5), mean: Math.round(mean), p10: q(0.1), p90: q(0.9), min: v[0]!, max: v[v.length - 1]! };
}

const summary: Record<string, unknown> = {};
for (const phase of ["approved", "rejected"] as const) {
  const ok = records.filter((r) => r.phase === phase && r.expected);
  const pick = (f: (r: CallRecord) => number | undefined) => ok.map(f).filter((x): x is number => x !== undefined);
  summary[phase] = {
    expected: ok.length,
    unexpected: records.filter((r) => r.phase === phase && !r.expected).length,
    endToEndMs: stats(pick((r) => r.t["done"])),
    commitMs: stats(pick((r) => (r.t["committed"] !== undefined && r.t["agent"] !== undefined ? r.t["committed"] - r.t["agent"] : undefined))),
    revealMs: stats(pick((r) => r.revealLatencyMs)),
    revealAttempts: stats(pick((r) => r.revealAttempts)),
    finalizeMs: stats(pick((r) => (r.t["finalized"] !== undefined && r.t["revealed"] !== undefined ? r.t["finalized"] - r.t["revealed"] : undefined))),
    signMs: stats(pick((r) => (r.t["signed"] !== undefined && r.t["finalized"] !== undefined ? r.t["signed"] - r.t["finalized"] : undefined))),
    settleMs: stats(pick((r) => (r.t["settled"] !== undefined && r.t["signed"] !== undefined ? r.t["settled"] - r.t["signed"] : undefined))),
    requestSpendGas: stats(pick((r) => (r.requestSpendGas ? Number(r.requestSpendGas) : undefined))),
    finalizeGas: stats(pick((r) => (r.finalizeGas ? Number(r.finalizeGas) : undefined))),
    holdGas: stats(pick((r) => (r.holdGas ? Number(r.holdGas) : undefined))),
    claimGas: stats(pick((r) => (r.claimGas ? Number(r.claimGas) : undefined))),
  };
}

const out = {
  started: started.toISOString(),
  network: network.label,
  vault: vaultAddress,
  goalId: goalId.toString(),
  signer: { url: signerUrl, keyStore: custody },
  agent: "scripted",
  policy: { budget: BUDGET.toString(), cap: CAP.toString(), calls: APPROVED + 1, funding: FUNDING.toString() },
  openGoalGas: openReceipt.gasUsed.toString(),
  summary,
  records,
};
const outArg = process.argv.indexOf("--out");
const dir = outArg === -1 ? join(process.cwd(), "..", "..", "docs", "runs") : process.argv[outArg + 1]!;
mkdirSync(dir, { recursive: true });
const file = join(dir, `bench-${started.toISOString().slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));

console.log(`\nsummary (milliseconds and gas; expected outcomes only)`);
console.log(JSON.stringify(summary, null, 2));
console.log(`\nwritten ${file}`);
console.log(`goal ${goalId} is still open with leftover USDC; run the sweep to return it.`);

// Statistics over the calls that behaved say nothing about the ones that did not.
const unexpected = records.filter((r) => !r.expected);
if (unexpected.length > 0) {
  console.log(`\n${unexpected.length} call(s) of ${records.length} did not end as expected.`);
  process.exitCode = 1;
}
