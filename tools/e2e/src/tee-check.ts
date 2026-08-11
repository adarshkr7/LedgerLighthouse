/**
 * Inco TEE round trip, in isolation — the narrowest script that proves the
 * confidential half of this system actually works.
 *
 * `demo.ts` proves the *product*: x402, USDC, the signer, the injection. That
 * makes it the wrong instrument for answering "is Inco itself working", because
 * a failure anywhere in the payment path looks the same from the outside. This
 * script removes everything that is not Inco. No USDC moves, the signer is never
 * started, and no vendor is contacted. What is left is exactly the two claims
 * worth checking:
 *
 *   1. **Encryption** — a value encrypted client-side to the enclave becomes an
 *      on-chain `euint256` handle the vault can compute over but nobody can read.
 *   2. **Decryption** — the enclave's attestation over a revealed decision
 *      verifies *on chain*, inside `finalizeDecision`, against the handle the
 *      vault stored.
 *
 * Claim 2 is checked twice over, in the only way that means anything: once for a
 * true decision, once for a false one, and then once more with the plaintext
 * deliberately flipped. If a lie verified, the attestation would be decoration.
 *
 * The second spend is the interesting one. It is under the public per-call cap
 * and its payee is allowlisted, so every plaintext precondition passes. The only
 * thing in the system that can refuse it is the encrypted remaining budget —
 * which by then has already been debited by the first spend, inside the enclave,
 * without this process ever learning the balance.
 *
 * Costs one Inco fee (~0.000001 ETH) plus gas for five transactions.
 */

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Lightning } from "@inco/lightning-js/lite";
import { handleTypes } from "@inco/lightning-js";

import { IncoDecisionReader, pollForDecision } from "@ntux402/orchestrator";

import {
  BASE_SEPOLIA_CHAIN_ID,
  INCO_FEE_ABI,
  INCO_SINGLETON,
  fmt,
  formatUsdc,
  loadDotEnv,
  ms,
  now,
  policyVaultAbi,
  required,
  requiredAddress,
  requiredHexKey,
} from "./config.js";

loadDotEnv();

// 0.10 USDC encrypted. Small on purpose: this budget is never spent against
// real money, it only has to be a number the enclave can compare.
const BUDGET = 100_000n;
// Deliberately far above both spends, so neither can be refused in plaintext.
// A bounce here has exactly one possible source.
const PER_CALL_CAP = 6_000_000n;
const FIRST_SPEND = 40_000n; // 0.04 — inside the budget
const SECOND_SPEND = 90_000n; // 0.09 — inside the *cap*, past what the budget has left

const rpcUrl = required("BASE_SEPOLIA_RPC_URL");
const vaultAddress = requiredAddress("POLICY_VAULT_ADDRESS");
const usdcAddress = requiredAddress("USDC_ADDRESS");

const user = privateKeyToAccount(requiredHexKey("DEPLOYER_PRIVATE_KEY"));
const relay = privateKeyToAccount(requiredHexKey("ORCHESTRATOR_RELAY_KEY"));

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
const userWallet = createWalletClient({ account: user, chain: baseSepolia, transport: http(rpcUrl) });
const relayWallet = createWalletClient({ account: relay, chain: baseSepolia, transport: http(rpcUrl) });
const abi = policyVaultAbi();

const rule = (label = "") =>
  console.log(`\n${label ? `--- ${label} ` : ""}${"-".repeat(Math.max(0, 62 - label.length))}\n`);

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label.padEnd(34)}${detail}`);
}

/**
 * Reads until the value settles, rather than once.
 *
 * Base Sepolia's public RPC is load-balanced, so the node that answers the read
 * after a receipt may not yet have the block that receipt came from — a read
 * straight after `waitForTransactionReceipt` can legitimately return stale
 * state. `VaultRelay.waitUntilVisible` handles this in the orchestrator for the
 * same reason. Bounded, so a genuinely wrong value still fails rather than
 * hanging.
 */
async function readUntil<T>(read: () => Promise<T>, want: T, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last = await read();
  while (last !== want && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    last = await read().catch(() => last);
  }
  return last;
}

// ------------------------------------------------------------------ preflight
rule("preflight");

const chainId = await publicClient.getChainId();
if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
  throw new Error(`Wrong chain: ${chainId}, expected ${BASE_SEPOLIA_CHAIN_ID}`);
}
check("chain", true, `${chainId}`);
check("vault", true, vaultAddress);
check(
  "user (pays the Inco fee)",
  true,
  `${user.address}  ${formatEther(await publicClient.getBalance({ address: user.address }))} ETH`,
);
check(
  "relay (gas only)",
  true,
  `${relay.address}  ${formatEther(await publicClient.getBalance({ address: relay.address }))} ETH`,
);

// Confirms the TEE executor is the contract the Solidity library is compiled
// against, rather than trusting that the address in Lib.sol is still live.
const incoCode = await publicClient.getCode({ address: INCO_SINGLETON });
check("Inco executor deployed", Boolean(incoCode && incoCode !== "0x"), INCO_SINGLETON);

const incoFee = (await publicClient.readContract({
  address: INCO_SINGLETON,
  abi: INCO_FEE_ABI,
  functionName: "getFee",
})) as bigint;
check("Inco fee", true, `${formatEther(incoFee)} ETH per encrypted input`);

// ----------------------------------------------------------------- encryption
rule("1. encrypt the budget client-side");

const zap = await Lightning.baseSepoliaTestnet({ hostChainRpcUrls: [rpcUrl] });

let t = now();
const budgetCiphertext = (await zap.encrypt(BUDGET, {
  // Bound to this pair. A ciphertext prepared for any other account or dapp
  // yields a handle `openGoal` cannot use — which is the reason the user, and
  // never the orchestrator, sends this transaction.
  accountAddress: user.address,
  dappAddress: vaultAddress,
  handleType: handleTypes.euint256,
})) as Hex;
const encryptMs = ms(t);

check("encrypted", budgetCiphertext.startsWith("0x"), `${formatUsdc(BUDGET)} USDC in ${fmt(encryptMs)}`);
check("ciphertext is opaque", !budgetCiphertext.includes(BUDGET.toString(16)), `${budgetCiphertext.length} hex chars`);

// -------------------------------------------------------------- handle, on chain
rule("2. open a goal — ciphertext becomes an on-chain handle");

t = now();
const openHash = await userWallet.writeContract({
  address: vaultAddress,
  abi,
  functionName: "openGoal",
  args: [
    {
      budgetCiphertext,
      perCallCap: PER_CALL_CAP,
      callsRemaining: 5,
      // Never used: nothing here settles. The field only has to be non-zero.
      payer: user.address,
      relay: relay.address,
      asset: usdcAddress,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      allowlist: [relay.address],
    },
  ],
  value: incoFee,
});
const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });
check("openGoal confirmed", openReceipt.status === "success", `${fmt(ms(t))}  gas ${openReceipt.gasUsed}`);

const opened = parseEventLogs({ abi, eventName: "GoalOpened", logs: openReceipt.logs })[0];
if (!opened) throw new Error("GoalOpened not emitted");
const { goalId, budgetHandle } = opened.args as unknown as { goalId: bigint; budgetHandle: Hex };

check("goalId", true, `${goalId}`);
check("budget handle", budgetHandle !== `0x${"0".repeat(64)}`, budgetHandle);
console.log(`\n  The handle above is the whole point: it is what the chain stores instead`);
console.log(`  of ${formatUsdc(BUDGET)}. Reading it back tells you nothing.`);

const reader = new IncoDecisionReader(zap);

/**
 * One spend, start to finish: commit the terms, wait for the enclave to publish
 * an attestation over the revealed decision, then push that attestation through
 * on-chain verification.
 */
async function spend(amount: bigint, resource: string, expected: boolean): Promise<void> {
  const started = now();
  const hash = await relayWallet.writeContract({
    address: vaultAddress,
    abi,
    functionName: "requestSpend",
    args: [goalId, amount, relay.address, resource],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  check("requestSpend confirmed", receipt.status === "success", `${fmt(ms(started))}  gas ${receipt.gasUsed}`);

  const requested = parseEventLogs({ abi, eventName: "SpendRequested", logs: receipt.logs })[0];
  if (!requested) throw new Error("SpendRequested not emitted");
  const { seq, decisionHandle } = requested.args as unknown as { seq: bigint; decisionHandle: Hex };
  check("decision handle", true, decisionHandle);
  console.log(`        committed — and at this moment nobody, including this script, knows the answer`);

  // The enclave processes the emitted events after the fact, so this is a
  // bounded poll and a timeout is a reported outcome, never a swallowed one.
  const outcome = await pollForDecision(reader, decisionHandle, { timeoutMs: 180_000 });
  if (outcome.kind !== "decided") {
    check("attestedReveal", false, `timed out after ${fmt(outcome.elapsedMs)} — ${outcome.lastError}`);
    return;
  }
  const { approved, signatures } = outcome.decision;
  check(
    "attestedReveal",
    true,
    `${approved} in ${fmt(outcome.latencyMs)} (${outcome.attempts} attempt${outcome.attempts === 1 ? "" : "s"}), ${signatures.length} signature${signatures.length === 1 ? "" : "s"}`,
  );
  check(`decision is ${expected}`, approved === expected, approved === expected ? "" : `got ${approved}`);

  // The attestation is only worth something if the opposite claim fails. Checked
  // by simulation so it costs nothing and cannot consume the pending spend.
  let liedAndVerified = false;
  try {
    await publicClient.simulateContract({
      address: vaultAddress,
      abi,
      functionName: "finalizeDecision",
      args: [goalId, seq, !approved, signatures],
      account: relay.address,
    });
    liedAndVerified = true;
  } catch {
    /* expected: signatures cover (handle, plaintext), so the flip cannot verify */
  }
  check("flipped plaintext is rejected", !liedAndVerified, `claimed ${!approved}, on-chain verification refused it`);

  t = now();
  const finalizeHash = await relayWallet.writeContract({
    address: vaultAddress,
    abi,
    functionName: "finalizeDecision",
    args: [goalId, seq, approved, signatures],
  });
  const finalizeReceipt = await publicClient.waitForTransactionReceipt({ hash: finalizeHash });
  check(
    "finalizeDecision confirmed",
    finalizeReceipt.status === "success",
    `${fmt(ms(t))}  gas ${finalizeReceipt.gasUsed}`,
  );

  const onChain = await readUntil(
    () =>
      publicClient.readContract({
        address: vaultAddress,
        abi,
        functionName: "isApproved",
        args: [goalId, seq],
      }) as Promise<boolean>,
    expected,
  );
  check("on-chain isApproved agrees", onChain === expected, `${onChain}`);
}

// --------------------------------------------------------------- approved path
rule(`3. spend ${formatUsdc(FIRST_SPEND)} — inside the encrypted budget`);
await spend(FIRST_SPEND, "tee-check/inside-budget", true);

// --------------------------------------------------------------- refused path
rule(`4. spend ${formatUsdc(SECOND_SPEND)} — inside the cap, past the budget`);
console.log(`  Public cap is ${formatUsdc(PER_CALL_CAP)} and the payee is allowlisted, so nothing in`);
console.log(`  plaintext can refuse this. The enclave already debited ${formatUsdc(FIRST_SPEND)},`);
console.log(`  leaving ${formatUsdc(BUDGET - FIRST_SPEND)} — a figure this process never saw.\n`);
await spend(SECOND_SPEND, "tee-check/past-budget", false);

// --------------------------------------------------------------------- cleanup
rule("5. close the goal");
const closeHash = await userWallet.writeContract({
  address: vaultAddress,
  abi,
  functionName: "closeGoal",
  args: [goalId],
});
const closeReceipt = await publicClient.waitForTransactionReceipt({ hash: closeHash });
check("closeGoal confirmed", closeReceipt.status === "success", `gas ${closeReceipt.gasUsed}`);

rule();
if (failures > 0) {
  console.error(`  ${failures} check(s) FAILED — the Inco path is not working.\n`);
  process.exit(1);
}
console.log(`  Inco TEE round trip verified: encryption in, attested decryption out,`);
console.log(`  both decisions checked on chain, goal ${goalId} closed.`);
console.log(`\n  https://sepolia.basescan.org/address/${vaultAddress}\n`);
