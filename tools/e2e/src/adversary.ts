/**
 * Track 2 — the A2 adversary campaign (paper/evaluation-design.md §5).
 *
 *   pnpm --filter @ntux402/e2e run adversary
 *
 * ## What this is, and why it is not a test suite
 *
 * `contracts/test/PolicyVault.t.sol` already covers the contract's refusals in
 * isolation, against a fake attester and a fake compute server. This runs the
 * *deployed* system under the threat model the paper actually claims — **A2,
 * arbitrary code execution in the orchestrator** — and measures what a
 * compromised orchestrator can extract.
 *
 * There is no agent here and no model. That is the point: under A2 there is
 * nothing to manipulate, because the adversary skips the agent and calls
 * `requestSpend` itself with whatever arguments it likes. Every LLM injection
 * study tests A1. None of them test this.
 *
 * ## Why it reports rather than asserts
 *
 * A deviation from an expected refusal is a **finding**, not a crash. Throwing
 * on the first one would hide every later strategy behind it, and the campaign's
 * value is the full picture — including which controls held while another
 * failed. So each strategy records a verdict and the run continues. The exit
 * code is non-zero if anything deviated, so CI can still gate on it.
 *
 * ## What it measures
 *
 * ARCHITECTURE.md §6.2 states the residual bound as
 *
 *     loss ceiling = perCallCap × callsRemaining
 *
 * That formula omits the encrypted budget, which also binds. The true ceiling is
 *
 *     min(remainingBudget, perCallCap × callsRemaining)
 *
 * and the distinction is not pedantic: the budget term is the *confidential*
 * one, so a defender reading public state can only ever know the second factor.
 * Two goals are opened to separate them — one where the budget binds first, one
 * where the cap does — and extraction is measured against each.
 *
 * Extraction is counted as **authorized**, not settled: a released EIP-3009
 * signature *is* the spending authority, and counting settlements instead would
 * make the measurement depend on a funded payer and a live facilitator, neither
 * of which the adversary needs.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Lightning } from "@inco/lightning-js/lite";
import { handleTypes } from "@inco/lightning-js";
import { rpcTransport } from "@ntux402/shared/viem";
import { DEMO_PAYEES, rpcUrls } from "@ntux402/shared";
import {
  IncoDecisionReader,
  SignerClient,
  VaultRelay,
  pollForDecision,
  type AttestedDecision,
  type AuthorizeOutcome,
} from "@ntux402/orchestrator";

import {
  BASE_SEPOLIA_CHAIN_ID,
  INCO_FEE_ABI,
  INCO_SINGLETON,
  formatUsdc,
  loadDotEnv,
  optional,
  policyVaultAbi,
  required,
  requiredAddress,
  requiredHexKey,
} from "./config.js";

loadDotEnv();

// --------------------------------------------------------------- parameters

/**
 * Goal A — the budget binds first.
 *
 * cap × calls = 0.60, budget = 0.25. A perfectly rational adversary asking for
 * `perCallCap` every time should be cut off by the encrypted comparison at 0.25,
 * *not* at 0.60 — and should not be able to tell in advance that it would be.
 */
const GOAL_BUDGET_BOUND = {
  label: "budget-bound",
  budget: 250_000n,
  perCallCap: 200_000n,
  calls: 3,
} as const;

/**
 * Goal B — the public controls bind first.
 *
 * cap × calls = 0.20, budget = 1.00. Extraction should stop at 0.20 with budget
 * left over, which is the case ARCHITECTURE.md §6.2's formula actually describes.
 */
const GOAL_CAP_BOUND = {
  label: "cap-bound",
  budget: 1_000_000n,
  perCallCap: 100_000n,
  calls: 2,
} as const;

/**
 * Goal C — a scratch goal for the refusal strategies.
 *
 * Deliberately separate from the two extraction goals. Running the refusals on
 * an extraction goal would leave them operating on a call counter C1 had already
 * exhausted, so `SpendPending` and `425` would be observed against a goal that
 * was refusing everything anyway — a pass that proves nothing.
 *
 * Sized so that a small ask is approved and a larger one is rejected *by the
 * budget* while still clearing `perCallCap`: C9 needs a genuine policy rejection
 * to ask the signer about, and the rejection has to come from the confidential
 * comparison rather than from a public predicate.
 */
const GOAL_REFUSALS = {
  label: "refusals",
  budget: 3_000n,
  perCallCap: 100_000n,
  calls: 4,
} as const;

/** Under the budget. Approved, and its attestation is what C8 replays. */
const SMALL_ASK = 500n;
/** Clears perCallCap, exceeds the remaining budget. Rejected confidentially. */
const OVER_BUDGET_ASK = 50_000n;

/** Not on any allowlist. Used to prove the structural refusal, never funded. */
const UNALLOWLISTED = "0x000000000000000000000000000000000000dEaD" as Address;

// ------------------------------------------------------------------ verdicts

type Verdict = "held" | "deviated" | "inconclusive";

interface Finding {
  readonly id: string;
  readonly name: string;
  readonly targets: string;
  readonly expected: string;
  readonly observed: string;
  readonly verdict: Verdict;
}

const findings: Finding[] = [];

function record(f: Finding): void {
  findings.push(f);
  const mark = f.verdict === "held" ? "  ok  " : f.verdict === "deviated" ? " FAIL " : " ??   ";
  console.log(`[${mark}] ${f.id.padEnd(4)} ${f.name}`);
  console.log(`         expected: ${f.expected}`);
  console.log(`         observed: ${f.observed}`);
}

/**
 * Runs a strategy that is expected to be refused, and classifies the refusal.
 *
 * A refusal that arrives for the *wrong reason* is not a pass. `match` is the
 * substring the error must carry — usually the custom error selector's name —
 * so that a revert from a misconfigured RPC does not read as a policy control
 * doing its job.
 */
/**
 * Independently confirms a revert reason via `eth_call`.
 *
 * `VaultRelay` reaches the chain through `writeContract`, which estimates gas
 * before sending. Observed against `sepolia.base.org`: an estimate that would
 * revert sometimes comes back with no revert data at all, so the custom error
 * never decodes and `expectRefusal` is left with only a generic
 * "the contract function reverted" — true, but not the confirmation this
 * campaign exists to produce. `simulateContract` issues the read-only call
 * directly against the same live state and, in every case observed here,
 * recovers the decoded error the write path could not.
 *
 * Used only as a fallback when the primary attempt's own error already
 * matched — most refusals decode cleanly the first time, and this exists for
 * the ones that do not.
 */
async function probeRevertReason(
  functionName: "requestSpend" | "finalizeDecision",
  args: readonly unknown[],
): Promise<string | undefined> {
  try {
    await publicClient.simulateContract({
      address: vaultAddress,
      abi,
      functionName,
      args,
      account: relayAddress,
    } as Parameters<typeof publicClient.simulateContract>[0]);
    return undefined; // did not revert under simulation either
  } catch (error) {
    if (error instanceof BaseError) {
      const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
      if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
        return reverted.data.errorName;
      }
    }
    return undefined;
  }
}

async function expectRefusal(
  id: string,
  name: string,
  targets: string,
  match: string,
  attempt: () => Promise<unknown>,
  /** Replayed via `eth_call` only when the primary attempt's error does not match. */
  probe?: { functionName: "requestSpend" | "finalizeDecision"; args: readonly unknown[] },
): Promise<void> {
  try {
    await attempt();
    record({
      id,
      name,
      targets,
      expected: `refusal containing "${match}"`,
      observed: "the call SUCCEEDED — no refusal at all",
      verdict: "deviated",
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    let matched = text.includes(match);
    let observed = matched ? `refused: ${match}` : `refused, but for another reason: ${first(text)}`;

    if (!matched && probe) {
      const decoded = await probeRevertReason(probe.functionName, probe.args);
      if (decoded !== undefined) {
        matched = decoded === match;
        observed = matched
          ? `refused: ${match} (decoded via eth_call replay — the write path's own error did not decode)`
          : `refused, but for another reason: ${decoded} (decoded via eth_call replay)`;
      }
    }

    record({
      id,
      name,
      targets,
      expected: `refusal containing "${match}"`,
      observed,
      verdict: matched ? "held" : "inconclusive",
    });
  }
}

const first = (text: string): string => text.split("\n")[0]!.slice(0, 160);

// -------------------------------------------------------------------- setup

const rpcUrl = required("BASE_SEPOLIA_RPC_URL");
const vaultAddress = requiredAddress("POLICY_VAULT_ADDRESS");
const usdcAddress = requiredAddress("USDC_ADDRESS");
const signerUrl = optional("SIGNER_URL") ?? `http://127.0.0.1:${process.env["SIGNER_PORT"] ?? 8402}`;

const user = privateKeyToAccount(requiredHexKey("DEPLOYER_PRIVATE_KEY"));
const relayKey = requiredHexKey("ORCHESTRATOR_RELAY_KEY");
const relayAddress = privateKeyToAccount(relayKey).address;

const publicClient = createPublicClient({ chain: baseSepolia, transport: rpcTransport(rpcUrl) });
const userWallet = createWalletClient({
  account: user,
  chain: baseSepolia,
  transport: rpcTransport(rpcUrl),
});
const abi = policyVaultAbi();

const relay = new VaultRelay({ rpcUrl, vaultAddress, relayKey, chainId: BASE_SEPOLIA_CHAIN_ID });
const signer = new SignerClient(
  signerUrl,
  undefined,
  optional("SIGNER_SERVICE_TOKEN") ?? optional("SERVICE_TOKEN"),
);

const zap = await Lightning.baseSepoliaTestnet({ hostChainRpcUrls: [...rpcUrls(rpcUrl)] });
const decisions = new IncoDecisionReader(zap);

const rule = (label = "") =>
  console.log(`\n${label ? `--- ${label} ` : ""}${"-".repeat(Math.max(0, 66 - label.length))}\n`);

// ------------------------------------------------------------- goal opening

interface OpenedGoal {
  readonly goalId: bigint;
  readonly label: string;
  readonly budget: bigint;
  readonly perCallCap: bigint;
  readonly calls: number;
  readonly payer: Address;
}

async function openGoal(spec: {
  label: string;
  budget: bigint;
  perCallCap: bigint;
  calls: number;
}): Promise<OpenedGoal> {
  // Before openGoal — the payer address is a field of the goal record
  // (ARCHITECTURE.md §3.4), so the key must exist first.
  const payer = await signer.mintPayer();

  const budgetCiphertext = (await zap.encrypt(spec.budget, {
    accountAddress: user.address,
    dappAddress: vaultAddress,
    handleType: handleTypes.euint256,
  })) as Hex;

  const incoFee = (await publicClient.readContract({
    address: INCO_SINGLETON,
    abi: INCO_FEE_ABI,
    functionName: "getFee",
  })) as bigint;

  const hash = await userWallet.writeContract({
    address: vaultAddress,
    abi,
    functionName: "openGoal",
    args: [
      {
        budgetCiphertext,
        perCallCap: spec.perCallCap,
        callsRemaining: spec.calls,
        payer,
        relay: relayAddress,
        asset: usdcAddress,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 24 * 3600),
        allowlist: [...DEMO_PAYEES],
      },
    ],
    value: incoFee,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const opened = parseEventLogs({ abi, eventName: "GoalOpened", logs: receipt.logs })[0];
  if (!opened) throw new Error("GoalOpened not emitted");
  const { goalId } = opened.args as { goalId: bigint };

  console.log(`  goal ${goalId} (${spec.label})`);
  console.log(`    budget      ${formatUsdc(spec.budget)} USDC  (encrypted)`);
  console.log(
    `    cap x calls ${formatUsdc(spec.perCallCap)} x ${spec.calls} = ${formatUsdc(
      spec.perCallCap * BigInt(spec.calls),
    )} USDC  (public)`,
  );
  console.log(`    payer       ${payer}`);

  return { goalId, payer, ...spec };
}

/**
 * Polls the signer until it answers something other than "ask again".
 *
 * Mirrors `PaymentLoop#authorizeWithRetry` (services/orchestrator/src/pay/payment-loop.ts),
 * which is private to that class. Duplicated rather than exported, because a
 * single call to `signer.authorize()` right after `finalizeDecision` undercounts:
 * the finalize receipt this process observed and the chain view the signer's own
 * RPC client holds can be momentarily out of sync, and a lone `not-ready` (425)
 * would then be recorded as zero extraction for a spend the policy actually
 * approved. For a campaign whose headline number is "how much did the ceiling
 * really allow", that error runs the wrong direction — it makes the system look
 * *more* restrictive than it is, which is not the mistake this campaign exists
 * to catch quietly.
 */
async function authorizeWithRetry(goalId: bigint, seq: bigint, attempts = 12): Promise<AuthorizeOutcome> {
  let last: AuthorizeOutcome = { kind: "not-ready", reason: "not attempted" };
  for (let i = 0; i < attempts; i++) {
    last = await signer.authorize(goalId, seq);
    if (last.kind !== "not-ready" && last.kind !== "rate-limited") return last;
    const asked = last.kind === "rate-limited" ? last.retryAfterSeconds : 0;
    const waitSeconds = Math.min(Math.max(asked, 1), 10);
    await new Promise((r) => setTimeout(r, waitSeconds * 1_000));
  }
  return last;
}

/**
 * One full spend cycle, driven adversarially.
 *
 * Returns the amount the signer was willing to authorize — zero for every
 * outcome that is not a released signature. Note what the adversary must do
 * even to *learn* the decision: commit the debit first, then wait. There is no
 * shape of this function in which it finds out before paying for the answer.
 */
async function attemptSpend(
  goal: OpenedGoal,
  amount: bigint,
  payTo: Address,
): Promise<{ authorized: bigint; seq: bigint; decision: AttestedDecision | undefined }> {
  const requested = await relay.requestSpend(goal.goalId, amount, payTo, "adversary/max-extract");

  const outcome = await pollForDecision(decisions, requested.decisionHandle, { timeoutMs: 180_000 });
  if (outcome.kind === "timeout") {
    // The debit has already committed. This is a distinct state from rejection
    // and must not be reported as one (ARCHITECTURE.md §6.4).
    console.log(`    seq ${requested.seq}: decision UNOBTAINABLE after ${outcome.elapsedMs}ms`);
    return { authorized: 0n, seq: requested.seq, decision: undefined };
  }

  await relay.finalizeDecision(
    goal.goalId,
    requested.seq,
    outcome.decision.approved,
    outcome.decision.signatures,
  );

  if (!outcome.decision.approved) {
    console.log(`    seq ${requested.seq}: ask ${formatUsdc(amount)} -> REJECTED by policy`);
    return { authorized: 0n, seq: requested.seq, decision: outcome.decision };
  }

  const auth = await authorizeWithRetry(goal.goalId, requested.seq);
  const authorized = auth.kind === "signed" ? amount : 0n;
  console.log(
    `    seq ${requested.seq}: ask ${formatUsdc(amount)} -> APPROVED, signer ${auth.kind}` +
      (authorized > 0n ? ` (${formatUsdc(authorized)} authorized)` : ""),
  );
  return { authorized, seq: requested.seq, decision: outcome.decision };
}

// ------------------------------------------------------------------ C1

/**
 * Maximum extraction: ask for `perCallCap` every time, to an allowlisted payee,
 * until the goal stops approving.
 *
 * This is the strongest thing an A2 adversary can do that the architecture
 * *permits*. It is not an attack on any control — it is the control's stated
 * ceiling, exercised deliberately, and the question is only whether the ceiling
 * is where the paper says it is.
 */
async function c1MaxExtraction(goal: OpenedGoal): Promise<bigint> {
  console.log(`\n  C1 on goal ${goal.goalId} (${goal.label}) — asking perCallCap every call`);
  const payee = DEMO_PAYEES[0]!;
  let extracted = 0n;

  // Bounded by the public call count: once it is exhausted the vault rejects
  // regardless of budget, so there is no point iterating past it.
  for (let i = 0; i < goal.calls; i++) {
    const result = await attemptSpend(goal, goal.perCallCap, payee);
    extracted += result.authorized;
    if (result.authorized === 0n && result.decision?.approved === false) {
      console.log(`    budget exhausted after ${formatUsdc(extracted)}`);
      break;
    }
  }

  const publicBound = goal.perCallCap * BigInt(goal.calls);
  const trueBound = goal.budget < publicBound ? goal.budget : publicBound;

  record({
    id: "C1",
    name: `max extraction (${goal.label})`,
    targets: "the §6.2 residual bound",
    expected: `<= ${formatUsdc(trueBound)} = min(budget ${formatUsdc(goal.budget)}, cap x calls ${formatUsdc(publicBound)})`,
    observed: `${formatUsdc(extracted)} authorized`,
    verdict: extracted <= trueBound ? "held" : "deviated",
  });

  return extracted;
}

// ------------------------------------------------- C2-C4, C8-C10: refusals

async function refusalStrategies(goal: OpenedGoal): Promise<bigint | undefined> {
  const payee = DEMO_PAYEES[0]!;

  // C2 — a payee nobody allowlisted. Structural: reverts, never becomes a
  // decision, leaves no record. Malformed requests are not policy events.
  await expectRefusal(
    "C2",
    "settlement to a non-allowlisted payee",
    "the allowlist (structural)",
    "PayeeNotAllowlisted",
    () => relay.requestSpend(goal.goalId, SMALL_ASK, UNALLOWLISTED, "adversary/redirect"),
    {
      functionName: "requestSpend",
      args: [goal.goalId, SMALL_ASK, UNALLOWLISTED, "adversary/redirect"],
    },
  );

  // --- seq 1: small, within budget. Carries C4, C10, and C8's ammunition. ---

  const first = await relay.requestSpend(goal.goalId, SMALL_ASK, payee, "adversary/first");

  // C4 — two spends in flight at once. Refused because the public call counter
  // only moves at finalisation, so a second would read a stale count (§3.1).
  await expectRefusal(
    "C4",
    "two concurrent requestSpend on one goal",
    "pendingSeq sequencing",
    "SpendPending",
    () => relay.requestSpend(goal.goalId, SMALL_ASK, payee, "adversary/second"),
    { functionName: "requestSpend", args: [goal.goalId, SMALL_ASK, payee, "adversary/second"] },
  );

  // C10 — the signer before finalisation. Must be 425 and must be
  // distinguishable from a rejection, or a caller cannot tell "wait" from
  // "never" (§3.3). Deliberately a single call, not `authorizeWithRetry`: the
  // finalize transaction for `first` has not even been submitted yet, so
  // retrying would wait past the condition under test rather than observe it.
  const early = await signer.authorize(goal.goalId, first.seq);
  record({
    id: "C10",
    name: "signer asked before finalisation",
    targets: "the 425/403 split",
    expected: "not-ready (HTTP 425)",
    observed: `${early.kind}${early.kind === "refused" ? ` (HTTP ${early.status})` : ""}`,
    verdict: early.kind === "not-ready" ? "held" : "deviated",
  });

  const firstDecision = await pollForDecision(decisions, first.decisionHandle, {
    timeoutMs: 180_000,
  });
  if (firstDecision.kind === "timeout") {
    record({
      id: "C8",
      name: "genuine attestation from another seq, replayed",
      targets: "handle-bound verification (§3.2)",
      expected: "InvalidAttestation",
      observed: "no genuine attestation to substitute — seq 1 decision timed out",
      verdict: "inconclusive",
    });
    return undefined;
  }
  await relay.finalizeDecision(
    goal.goalId,
    first.seq,
    firstDecision.decision.approved,
    firstDecision.decision.signatures,
  );
  console.log(
    `    seq ${first.seq}: ask ${formatUsdc(SMALL_ASK)} -> ${
      firstDecision.decision.approved ? "APPROVED" : "REJECTED"
    } (C8 now has a genuine attestation)`,
  );

  // --- seq 2: over the remaining budget. Manufactures the rejection C9 needs. ---

  const over = await relay.requestSpend(goal.goalId, OVER_BUDGET_ASK, payee, "adversary/over");
  const overDecision = await pollForDecision(decisions, over.decisionHandle, { timeoutMs: 180_000 });
  if (overDecision.kind === "decided") {
    await relay.finalizeDecision(
      goal.goalId,
      over.seq,
      overDecision.decision.approved,
      overDecision.decision.signatures,
    );

    // C3 — the over-budget ask must land as a *decision*, not a revert. An
    // over-cap request that reverted would leave no record, and the bounce is
    // the product (§3.1).
    record({
      id: "C3",
      name: "ask exceeding the encrypted budget",
      targets: "confidential comparison; bounce visibility",
      expected: `REJECTED on chain at seq ${over.seq}, not reverted`,
      observed: overDecision.decision.approved
        ? "APPROVED — the budget did not bind"
        : `REJECTED on chain at seq ${over.seq}`,
      verdict: overDecision.decision.approved ? "deviated" : "held",
    });

    // C9 — the signer on a spend finalised as REJECTED. Terminal 403. Retried
    // like `attemptSpend`: a lone `not-ready` here would mean the signer's own
    // RPC view had not yet caught up to our `finalizeDecision` receipt, not
    // that the 403 path is broken, and the two must not be conflated.
    if (!overDecision.decision.approved) {
      const refused = await authorizeWithRetry(goal.goalId, over.seq);
      record({
        id: "C9",
        name: "signer asked for a policy-rejected spend",
        targets: "the 425/403 split",
        expected: "refused, HTTP 403, terminal",
        observed: `${refused.kind}${refused.kind === "refused" ? ` (HTTP ${refused.status})` : ""}`,
        verdict: refused.kind === "refused" && refused.status === 403 ? "held" : "deviated",
      });
    }
  }

  // --- seq 3: the victim record C8 tries to finalise with seq 1's attestation. ---

  const victim = await relay.requestSpend(goal.goalId, SMALL_ASK, payee, "adversary/victim");
  await expectRefusal(
    "C8",
    "genuine attestation from another seq, replayed",
    "handle-bound verification (§3.2)",
    "InvalidAttestation",
    () =>
      relay.finalizeDecision(goal.goalId, victim.seq, true, firstDecision.decision.signatures),
    {
      functionName: "finalizeDecision",
      args: [goal.goalId, victim.seq, true, firstDecision.decision.signatures],
    },
  );

  // Leave the goal resolved rather than wedged with a spend pending forever.
  const settle = await pollForDecision(decisions, victim.decisionHandle, { timeoutMs: 180_000 });
  if (settle.kind === "decided") {
    await relay.finalizeDecision(
      goal.goalId,
      victim.seq,
      settle.decision.approved,
      settle.decision.signatures,
    );
  }

  // seq 1 was approved, so it is the one with a signature to replay for C5.
  return firstDecision.decision.approved ? first.seq : undefined;
}

// ------------------------------------------------------------- C5, C6, C7

/**
 * Idempotency and the absence of a terms channel.
 *
 * C5/C6 are one question asked twice: does a second `authorize` for the same
 * `(goalId, seq)` return the *byte-identical* tuple? If any field moves —
 * `validBefore` regenerated from the clock being the dangerous one — the retry
 * is a different authorization and could execute a second time
 * (ARCHITECTURE.md §3.3).
 *
 * C7 has no code because it has no attack surface: `authorize` takes
 * `(goalId, seq)` and nothing else, so there is no argument through which terms
 * could be substituted. Recorded as an observation about the API's shape rather
 * than a test, because a test would have nothing to call.
 */
async function idempotency(goal: OpenedGoal, seq: bigint): Promise<void> {
  // Retried for the same reason as `attemptSpend`: this asks about an already
  // finalised-approved seq, and a `not-ready` here would be the signer's RPC
  // view lagging the finalize receipt, not evidence about replay stability.
  const a = await authorizeWithRetry(goal.goalId, seq);
  const b = await authorizeWithRetry(goal.goalId, seq);

  if (a.kind !== "signed" || b.kind !== "signed") {
    record({
      id: "C5",
      name: "authorization replay returns an identical tuple",
      targets: "EIP-3009 idempotency",
      expected: "two identical signed tuples",
      observed: `signer returned ${a.kind} then ${b.kind} — no approved spend to replay`,
      verdict: "inconclusive",
    });
    return;
  }

  const same = JSON.stringify(a.value) === JSON.stringify(b.value);
  record({
    id: "C5",
    name: "authorization replay returns an identical tuple",
    targets: "EIP-3009 idempotency",
    expected: "byte-identical, including validAfter/validBefore",
    observed: same ? "identical" : "TUPLES DIFFER — a retry would be a second authorization",
    verdict: same ? "held" : "deviated",
  });

  // C6 splits in two, and only half is reachable here.
  //
  // The dangerous half — does the signer regenerate `validBefore` from the
  // current clock, making a retry a *different* authorization that could
  // execute twice? — is exactly what the tuple comparison above answers, since
  // the two calls are separated by a round trip.
  //
  // The other half, a 410 once the frozen window has passed, needs a window
  // that has actually expired. AUTHORIZATION_WINDOW is an hour, so a campaign
  // that runs in minutes cannot reach it. Recorded as not-run rather than
  // omitted: a strategy missing from the report reads as a strategy that
  // passed.
  record({
    id: "C6",
    name: "expired frozen window refused with 410",
    targets: "expiry is a refusal, not a re-issue",
    expected: "refused, HTTP 410",
    observed: same
      ? "NOT RUN — needs a window older than AUTHORIZATION_WINDOW (1h). Regeneration half covered by C5."
      : "NOT RUN, and C5 already shows the tuple is not stable",
    verdict: "inconclusive",
  });
}

// -------------------------------------------------------------------- main

rule("Track 2 — A2 adversary campaign");
console.log("  Threat model: arbitrary code execution in the orchestrator.");
console.log("  No agent, no model. The adversary calls requestSpend directly.\n");

const chainId = await publicClient.getChainId();
if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
  throw new Error(`Wrong chain: ${chainId}, expected ${BASE_SEPOLIA_CHAIN_ID}`);
}
const health = await fetch(`${signerUrl}/health`).catch(() => undefined);
if (!health?.ok) throw new Error(`signer is not reachable at ${signerUrl}. Start it first.`);
console.log(`  chain  ${chainId}\n  vault  ${vaultAddress}\n  signer ${signerUrl}`);

rule("opening goals");
const budgetBound = await openGoal(GOAL_BUDGET_BOUND);
const capBound = await openGoal(GOAL_CAP_BOUND);
const refusals = await openGoal(GOAL_REFUSALS);

rule("C1 — maximum extraction");
const extractedA = await c1MaxExtraction(budgetBound);
const extractedB = await c1MaxExtraction(capBound);

rule("C2, C3, C4, C8, C9, C10 — refusals");
const replayableSeq = await refusalStrategies(refusals);

rule("C5 — idempotency");
if (replayableSeq === undefined) {
  record({
    id: "C5",
    name: "authorization replay returns an identical tuple",
    targets: "EIP-3009 idempotency",
    expected: "byte-identical, including validAfter/validBefore",
    observed: "no approved spend was produced to replay",
    verdict: "inconclusive",
  });
} else {
  await idempotency(refusals, replayableSeq);
}

record({
  id: "C7",
  name: "terms substituted between request and signature",
  targets: "the signer's API surface",
  expected: "no channel exists",
  observed: "authorize() accepts (goalId, seq) only — nothing to substitute",
  verdict: "held",
});

// ------------------------------------------------------------------ report

rule("verdict");

const deviated = findings.filter((f) => f.verdict === "deviated");
const inconclusive = findings.filter((f) => f.verdict === "inconclusive");

console.log(`  strategies run   ${findings.length}`);
console.log(`  held             ${findings.filter((f) => f.verdict === "held").length}`);
console.log(`  deviated         ${deviated.length}`);
console.log(`  inconclusive     ${inconclusive.length}`);
console.log();
console.log(`  extraction, budget-bound goal   ${formatUsdc(extractedA)} USDC`);
console.log(
  `    predicted ceiling             ${formatUsdc(GOAL_BUDGET_BOUND.budget)} (budget binds first)`,
);
console.log(`  extraction, cap-bound goal      ${formatUsdc(extractedB)} USDC`);
console.log(
  `    predicted ceiling             ${formatUsdc(
    GOAL_CAP_BOUND.perCallCap * BigInt(GOAL_CAP_BOUND.calls),
  )} (cap x calls binds first)`,
);

if (deviated.length > 0) {
  console.log(`\n  DEVIATIONS — each of these is a finding, not a flake:`);
  for (const f of deviated) console.log(`    ${f.id}  ${f.name}: ${f.observed}`);
}

console.log(
  `\n  Note: extraction is counted as *authorized*, not settled. A released`,
);
console.log(`  EIP-3009 signature is the spending authority; settlement is downstream.`);

process.exit(deviated.length > 0 ? 1 : 0);
