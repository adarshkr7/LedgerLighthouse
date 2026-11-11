/**
 * Matched baselines for the paper: one paid call through three designs, interleaved,
 * on the same RPC, relay, vendor and token.
 *
 *   plain       x402 "exact": the payer signs a transferWithAuthorization straight to
 *               the vendor and one transaction settles it. No policy at all.
 *   plaintext   PlaintextEscrowVault: the same escrow path as the firewall, with the
 *               limits in the clear and the decision made in the request itself.
 *   confidential EscrowPolicyVault: the deployed firewall, with Inco's decision,
 *               finalization and the signer service.
 *
 *   pnpm --filter @ntux402/e2e exec tsx src/baseline-bench.ts [--rounds 10]
 *
 * Every attempt is recorded, failed or stalled ones included, with each stage's wall
 * time and each transaction's gas and fee. Nothing is dropped from the output. What is
 * not matched, and is said so in the output: the plain and plaintext arms sign in this
 * process with keys derived from the local signer's seed, while the confidential arm
 * asks the signer service over HTTP on this machine; signing itself is a few
 * milliseconds in both.
 *
 * Needs .env as for `bench`, PLAINTEXT_BASELINE_VAULT, VENDOR_PRIVATE_KEY and
 * SIGNER_SEED_PATH, and the services running.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { handleTypes } from "@inco/lightning-js";
import {
  AUTH_CAPTURE_ESCROW,
  ENROLLMENT_TYPES,
  ERC3009_TOKEN_COLLECTOR,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  escrowPolicyVaultAbi,
  usdcAbi,
  type PaymentInfo,
} from "@ntux402/shared";
import { escrowNonce, rpcTransport, sendingAccount, viemChain } from "@ntux402/shared/viem";
import { findRepoRoot } from "@ntux402/shared/node";
import { SignerClient, VaultRelay, connectLightning, pollForDecision } from "@ntux402/orchestrator";
import { fileKeyStore } from "@ntux402/signer";

import {
  INCO_FEE_ABI,
  INCO_SINGLETON,
  REPO_ROOT,
  loadDotEnv,
  networkFromEnv,
  optional,
  requiredAddress,
  requiredHexKey,
} from "./config.js";
import { enroll } from "./enroll.js";
import { decisionSource } from "./escrow.js";

loadDotEnv();

const ROUNDS = Number(process.argv[process.argv.indexOf("--rounds") + 1] ?? 10) || 10;
const AMOUNT = 1_000n; // 0.001 USDC per paid call
const FUNDING = AMOUNT * BigInt(ROUNDS + 2);
const CAPTURE_AFTER = 600;

const { network, rpcUrl, usdcAddress } = networkFromEnv();
const chain = viemChain(network);
const confidentialVault = requiredAddress("POLICY_VAULT_ADDRESS");
const plaintextVault = requiredAddress("PLAINTEXT_BASELINE_VAULT");
const signerUrl = optional("SIGNER_URL") ?? "http://127.0.0.1:8402";

const user = sendingAccount(requiredHexKey("DEPLOYER_PRIVATE_KEY"));
const relayKey = requiredHexKey("ORCHESTRATOR_RELAY_KEY");
const relayAccount = sendingAccount(relayKey);
const vendor = sendingAccount(requiredHexKey("VENDOR_PRIVATE_KEY"));

const pub = createPublicClient({ chain, transport: rpcTransport(rpcUrl) });
const wallet = (account: ReturnType<typeof sendingAccount>) =>
  createWalletClient({ account, chain, transport: rpcTransport(rpcUrl) });
const userWallet = wallet(user);
const relayWallet = wallet(relayAccount);
const vendorWallet = wallet(vendor);

const seedPath = (() => {
  const p = optional("SIGNER_SEED_PATH") ?? ".keys/signer-seed.json";
  return isAbsolute(p) ? p : resolve(findRepoRoot(), p);
})();

const plaintextAbi = parseAbi([
  "struct GoalParams { uint32 callsRemaining; uint32 maxAttempts; address payer; address relay; address asset; uint64 expiry; address[] allowlist; }",
  "struct PaymentInfo { address operator; address payer; address receiver; address token; uint120 maxAmount; uint48 preApprovalExpiry; uint48 authorizationExpiry; uint48 refundExpiry; uint16 minFeeBps; uint16 maxFeeBps; address feeReceiver; uint256 salt; }",
  "function openEnrolledGoal(GoalParams params, uint256 budget, uint256 cap, bytes32 enrollmentId, bytes signature) returns (uint256)",
  "function requestEscrowSpend(uint256 goalId, uint256 amount, address payTo, uint64 payBy, uint48 captureDeadline, bytes policyData) returns (uint64, bool)",
  "function authorize(PaymentInfo info, uint256 amount, address tokenCollector, bytes collectorData)",
  "function claim(uint256 goalId, uint64 seq)",
  "function escrowPayment(uint256 goalId, uint64 seq) view returns (PaymentInfo)",
  "function goalCount() view returns (uint256)",
  "event SpendDecided(uint256 indexed goalId, uint64 indexed seq, address indexed payTo, uint256 amount, bool approved)",
]);
const transferAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);

// ------------------------------------------------------------------ records

type Arm = "plain" | "plaintext" | "confidential";
interface Stage {
  readonly name: string;
  readonly ms: number;
  readonly gas?: string;
  readonly feeWei?: string;
  readonly tx?: Hex;
}
interface Attempt {
  readonly arm: Arm;
  readonly round: number;
  readonly outcome: "paid" | "failed" | "stalled";
  readonly error?: string;
  readonly totalMs: number;
  readonly stages: Stage[];
}
const attempts: Attempt[] = [];

const now = () => performance.now();
async function timed<T>(stages: Stage[], name: string, fn: () => Promise<T>): Promise<T> {
  const t = now();
  const value = await fn();
  stages.push({ name, ms: Math.round(now() - t) });
  return value;
}
async function tx(stages: Stage[], name: string, send: () => Promise<Hex>): Promise<TransactionReceipt> {
  const t = now();
  const hash = await send();
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${name} reverted (${hash})`);
  stages.push({
    name,
    ms: Math.round(now() - t),
    gas: receipt.gasUsed.toString(),
    feeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    tx: hash,
  });
  return receipt;
}

const toStruct = (p: PaymentInfo) => ({
  ...p,
  maxAmount: BigInt(p.maxAmount),
  salt: BigInt(p.salt),
  preApprovalExpiry: Number(p.preApprovalExpiry),
  authorizationExpiry: Number(p.authorizationExpiry),
  refundExpiry: Number(p.refundExpiry),
  minFeeBps: Number(p.minFeeBps),
  maxFeeBps: Number(p.maxFeeBps),
});

const usdcDomain = { name: network.usdc.eip712Name, version: network.usdc.eip712Version, chainId: network.chainId, verifyingContract: usdcAddress } as const;

async function signReceive(key: { signTypedData: ReturnType<typeof privateKeyToAccount>["signTypedData"] }, info: PaymentInfo): Promise<Hex> {
  return key.signTypedData({
    domain: usdcDomain,
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: info.payer,
      to: ERC3009_TOKEN_COLLECTOR,
      value: BigInt(info.maxAmount),
      validAfter: 0n,
      validBefore: BigInt(info.preApprovalExpiry),
      nonce: escrowNonce(info, { escrow: AUTH_CAPTURE_ESCROW, chainId: network.chainId }),
    },
  });
}

async function fund(to: Address, amount: bigint): Promise<void> {
  const hash = await userWallet.writeContract({ address: usdcAddress, abi: usdcAbi, functionName: "transfer", args: [to, amount] });
  await pub.waitForTransactionReceipt({ hash });
}

// --------------------------------------------------------------------- setup

const runId = toHex(BigInt(Date.now()));
console.log(`baseline-bench: ${ROUNDS} rounds, run ${runId}`);

// plain: a payer the agent holds, as in x402 without a firewall.
const plainStore = fileKeyStore(seedPath, { chainId: network.chainId, vault: "0x0000000000000000000000000000000000000000" });
const plainPayer = await plainStore.payer(user.address, keccak256(toHex(`plain-x402/${runId}`)));
await fund(plainPayer.address, FUNDING);

// plaintext: enrolled with the same enrollment key, for its own vault.
const plainVaultStore = fileKeyStore(seedPath, { chainId: network.chainId, vault: plaintextVault });
const ptId = keccak256(toHex(`plaintext/${runId}`));
const ptPayer = await plainVaultStore.payer(user.address, ptId);
const ptStatement = await (await plainVaultStore.enrollment()).signTypedData({
  domain: { name: "PlaintextEscrowVault", version: "1", chainId: network.chainId, verifyingContract: plaintextVault },
  types: ENROLLMENT_TYPES,
  primaryType: "Enrollment",
  message: { payer: ptPayer.address, owner: user.address, enrollmentId: ptId },
});
const params = {
  callsRemaining: ROUNDS + 1,
  maxAttempts: ROUNDS + 1,
  relay: relayAccount.address,
  asset: usdcAddress,
  expiry: BigInt(Math.floor(Date.now() / 1000) + 6 * 3600),
  allowlist: [vendor.address],
};
const ptOpen = await pub.waitForTransactionReceipt({
  hash: await userWallet.writeContract({
    address: plaintextVault,
    abi: plaintextAbi,
    functionName: "openEnrolledGoal",
    args: [{ ...params, payer: ptPayer.address }, FUNDING, AMOUNT, ptId, ptStatement],
  }),
});
const ptGoal = (await pub.readContract({ address: plaintextVault, abi: plaintextAbi, functionName: "goalCount" })) as bigint;
await fund(ptPayer.address, FUNDING);

// confidential: the deployed firewall, enrolled through the signer service.
const signer = new SignerClient(signerUrl, undefined, optional("SIGNER_SERVICE_TOKEN") ?? optional("SERVICE_TOKEN"));
const enrolled = await enroll({ signer, reader: pub, vault: confidentialVault, owner: user.address, chainId: network.chainId });
const zap = await connectLightning(network, rpcUrl);
const encrypt = async (v: bigint) =>
  (await zap.encrypt(v, { accountAddress: user.address, dappAddress: confidentialVault, handleType: handleTypes.euint256 })) as Hex;
const incoFee = (await pub.readContract({ address: INCO_SINGLETON, abi: INCO_FEE_ABI, functionName: "getFee" })) as bigint;
const cfOpen = await pub.waitForTransactionReceipt({
  hash: await userWallet.writeContract({
    address: confidentialVault,
    abi: escrowPolicyVaultAbi,
    functionName: "openEnrolledGoal",
    args: [
      {
        budgetCiphertext: await encrypt(FUNDING),
        perCallCapCiphertext: await encrypt(AMOUNT),
        callsRemaining: ROUNDS + 1,
        maxAttempts: ROUNDS + 1,
        payer: enrolled.payer,
        relay: relayAccount.address,
        asset: usdcAddress,
        expiry: params.expiry,
        allowlist: [vendor.address],
      },
      enrolled.enrollmentId,
      enrolled.signature,
    ],
    value: 2n * incoFee,
  }),
});
const cfGoal = (await pub.readContract({ address: confidentialVault, abi: escrowPolicyVaultAbi, functionName: "payerGoal", args: [enrolled.payer] })) as bigint;
await fund(enrolled.payer, FUNDING);
const relay = new VaultRelay({ rpcUrl, vaultAddress: confidentialVault, relayKey, chainId: network.chainId });
const decisions = await decisionSource(zap, pub, confidentialVault);

console.log(`  plain payer ${plainPayer.address}`);
console.log(`  plaintext goal ${ptGoal} (open gas ${ptOpen.gasUsed})  confidential goal ${cfGoal} (open gas ${cfOpen.gasUsed})`);

// ---------------------------------------------------------------------- arms

async function plainCall(stages: Stage[]): Promise<void> {
  const nonce = keccak256(toHex(`${runId}/${stages.length}/${Math.random()}`));
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await timed(stages, "sign", () =>
    plainPayer.signTypedData({
      domain: usdcDomain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: plainPayer.address, to: vendor.address, value: AMOUNT, validAfter: 0n, validBefore, nonce },
    }),
  );
  await tx(stages, "settle", () =>
    relayWallet.writeContract({
      address: usdcAddress,
      abi: transferAbi,
      functionName: "transferWithAuthorization",
      args: [plainPayer.address, vendor.address, AMOUNT, 0n, validBefore, nonce, signature],
    }),
  );
}

async function plaintextCall(stages: Stage[]): Promise<void> {
  const payBy = BigInt(Math.floor(Date.now() / 1000) + 300);
  const receipt = await tx(stages, "request+decide", () =>
    relayWallet.writeContract({
      address: plaintextVault,
      abi: plaintextAbi,
      functionName: "requestEscrowSpend",
      args: [ptGoal, AMOUNT, vendor.address, payBy, Number(payBy) + CAPTURE_AFTER, "0x"],
    }),
  );
  const { parseEventLogs } = await import("viem");
  const decided = parseEventLogs({ abi: plaintextAbi, eventName: "SpendDecided", logs: receipt.logs })[0]!;
  if (!decided.args.approved) throw new Error("plaintext policy rejected");
  const seq = decided.args.seq;
  const info = (await pub.readContract({ address: plaintextVault, abi: plaintextAbi, functionName: "escrowPayment", args: [ptGoal, seq] })) as unknown as PaymentInfo;
  const signature = await timed(stages, "sign", () => signReceive(ptPayer, info));
  await tx(stages, "authorize (hold)", () =>
    relayWallet.writeContract({
      address: plaintextVault,
      abi: plaintextAbi,
      functionName: "authorize",
      args: [toStruct(info), BigInt(info.maxAmount), ERC3009_TOKEN_COLLECTOR, signature],
    }),
  );
  await tx(stages, "claim", () =>
    vendorWallet.writeContract({ address: plaintextVault, abi: plaintextAbi, functionName: "claim", args: [ptGoal, seq] }),
  );
}

class Stalled extends Error {}

async function confidentialCall(stages: Stage[]): Promise<void> {
  const payBy = BigInt(Math.floor(Date.now() / 1000) + 300);
  const t = now();
  const requested = await relay.requestEscrowSpend(cfGoal, AMOUNT, vendor.address, "baseline-bench", payBy, Number(payBy) + CAPTURE_AFTER, `0x${"00".repeat(32)}`);
  const commit = await pub.getTransactionReceipt({ hash: requested.commitTx });
  stages.push({
    name: "request",
    ms: Math.round(now() - t),
    gas: commit.gasUsed.toString(),
    feeWei: (commit.gasUsed * commit.effectiveGasPrice).toString(),
    tx: requested.commitTx,
  });
  const decision = await timed(stages, "inco decision", () =>
    pollForDecision(decisions, requested.decisionHandle, { timeoutMs: 180_000 }),
  );
  if (decision.kind === "timeout") throw new Stalled(`no decision for seq ${requested.seq} within 180 s`);
  const fin = await timed(stages, "finalize", () =>
    relay.finalizeDecision(cfGoal, requested.seq, decision.decision.approved, decision.decision.signatures),
  );
  const finReceipt = await pub.getTransactionReceipt({ hash: fin.txHash });
  stages[stages.length - 1] = {
    ...stages[stages.length - 1]!,
    gas: fin.gasUsed.toString(),
    feeWei: (finReceipt.gasUsed * finReceipt.effectiveGasPrice).toString(),
    tx: fin.txHash,
  };
  if (!decision.decision.approved) throw new Error("confidential policy rejected");
  const signed = await timed(stages, "sign", async () => {
    for (let i = 0; i < 20; i++) {
      const out = await signer.authorize(cfGoal, requested.seq);
      if (out.kind === "signed") return out.value;
      if (out.kind !== "not-ready" && out.kind !== "rate-limited") throw new Error(`signer ${out.kind}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("signer not ready after 20 s");
  });
  const info = signed.payment! as unknown as PaymentInfo;
  await tx(stages, "authorize (hold)", () =>
    relayWallet.writeContract({
      address: confidentialVault,
      abi: escrowPolicyVaultAbi,
      functionName: "authorize",
      args: [toStruct(info), BigInt(info.maxAmount), ERC3009_TOKEN_COLLECTOR, signed.signature],
    }),
  );
  await tx(stages, "claim", () =>
    vendorWallet.writeContract({
      address: confidentialVault,
      abi: escrowPolicyVaultAbi,
      functionName: "claim",
      args: [cfGoal, requested.seq, `0x${"00".repeat(32)}`],
    }),
  );
}

// ---------------------------------------------------------------------- run

const ARMS: Record<Arm, (s: Stage[]) => Promise<void>> = { plain: plainCall, plaintext: plaintextCall, confidential: confidentialCall };
const ORDER: Arm[] = ["plain", "plaintext", "confidential"];

for (let round = 0; round < ROUNDS; round++) {
  // Rotated each round, so no arm always runs first or after the same one.
  const order = ORDER.map((_, i) => ORDER[(i + round) % ORDER.length]!);
  for (const arm of order) {
    const stages: Stage[] = [];
    const t = now();
    let outcome: Attempt["outcome"] = "paid";
    let error: string | undefined;
    try {
      await ARMS[arm](stages);
    } catch (e) {
      outcome = e instanceof Stalled ? "stalled" : "failed";
      error = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);
    }
    const a: Attempt = { arm, round, outcome, totalMs: Math.round(now() - t), stages, ...(error ? { error } : {}) };
    attempts.push(a);
    console.log(`  round ${round} ${arm.padEnd(12)} ${outcome.padEnd(7)} ${(a.totalMs / 1000).toFixed(1)} s${error ? `  ${error}` : ""}`);
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? undefined : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const summary = Object.fromEntries(
  ORDER.map((arm) => {
    const mine = attempts.filter((a) => a.arm === arm);
    const paid = mine.filter((a) => a.outcome === "paid");
    const gas = paid.map((a) => a.stages.reduce((g, s) => g + Number(s.gas ?? 0), 0));
    return [
      arm,
      {
        attempts: mine.length,
        paid: paid.length,
        failed: mine.filter((a) => a.outcome === "failed").length,
        stalled: mine.filter((a) => a.outcome === "stalled").length,
        medianMsPaid: median(paid.map((a) => a.totalMs)),
        maxMsPaid: paid.length ? Math.max(...paid.map((a) => a.totalMs)) : undefined,
        medianGasPerPaidCall: median(gas),
        medianFeeWeiPerPaidCall: median(paid.map((a) => a.stages.reduce((f, s) => f + Number(s.feeWei ?? 0), 0))),
        transactionsPerPaidCall: paid[0]?.stages.filter((s) => s.tx).length,
      },
    ];
  }),
);
console.log(JSON.stringify(summary, null, 2));

const outDir = join(REPO_ROOT, "docs", "runs");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `baseline-bench-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      runId,
      network: network.label,
      rpc: rpcUrl.split(",")[0],
      vaults: { confidential: confidentialVault, plaintext: plaintextVault },
      goals: { confidential: cfGoal.toString(), plaintext: ptGoal.toString() },
      amountAtomic: AMOUNT.toString(),
      rounds: ROUNDS,
      notMatched: "plain and plaintext sign in-process; confidential signs through the signer service over local HTTP",
      openGas: { confidential: cfOpen.gasUsed.toString(), plaintext: ptOpen.gasUsed.toString() },
      incoFeeWeiPerEncryptedInput: incoFee.toString(),
      summary,
      attempts,
    },
    null,
    2,
  ),
);
console.log(`wrote ${file}`);
