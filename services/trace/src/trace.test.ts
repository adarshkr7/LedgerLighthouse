/**
 * M5 acceptance tests (IMPLEMENTATION.md §6):
 *
 *   "Passes when: the verifier validates a good trace, rejects a tampered step,
 *    rejects a swapped attestation, and runs with no dependency on your
 *    services beyond a public RPC."
 *
 * All four are here. The chain is faked at the RPC layer rather than by
 * injecting a reader, so the verifier's real contract calls and real ABI
 * encoding are exercised — a verifier tested against a mock of itself proves
 * nothing.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  encodeFunctionResult,
  toFunctionSelector,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import { policyVaultAbi, usdcAbi } from "@ntux402/shared";

import { canonicalJson } from "./canonical.js";
import { TraceBuilder } from "./builder.js";
import { merkleProof, merkleRoot, verifyMerkleProof, hashLeaf, hashNode } from "./merkle.js";
import { GENESIS_HASH, type Trace } from "./step.js";
import { verifyTrace } from "./verify.js";

const VAULT: Address = "0x0C759D06a1c14F43852D7b078Db2f8C342F15921";
const CHAIN_ID = 84532;
const HANDLE = `0x${"ab".repeat(32)}` as Hex;
const COMMIT_TX = `0x${"11".repeat(32)}` as Hex;
const FINALIZE_TX = `0x${"22".repeat(32)}` as Hex;

/** Minimal Base Sepolia stand-in, answering only what the verifier asks. */
class FakeChain {
  chainId = CHAIN_ID;
  storedHandle: Hex = HANDLE;
  finalized = true;
  approved = true;
  commitTxTo: Address | undefined = VAULT;
  authorizationUsed = true;

  install(): void {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const result = this.#handle(body.method, body.params);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  #handle(method: string, params: unknown[]): unknown {
    if (method === "eth_chainId") return `0x${this.chainId.toString(16)}`;
    if (method === "eth_getTransactionByHash") {
      if (this.commitTxTo === undefined) return null;
      return {
        hash: params[0],
        to: this.commitTxTo,
        from: "0x0000000000000000000000000000000000000001",
        value: "0x0",
        input: "0x",
        nonce: "0x0",
        gas: "0x0",
        blockHash: `0x${"cc".repeat(32)}`,
        blockNumber: "0x1",
        transactionIndex: "0x0",
        type: "0x2",
        chainId: `0x${this.chainId.toString(16)}`,
      };
    }
    if (method === "eth_call") {
      const { data } = params[0] as { data: Hex };
      const selector = data.slice(0, 10);
      const fn = SELECTORS[selector];
      switch (fn) {
        case "decisionHandle":
          return encodeFunctionResult({
            abi: policyVaultAbi,
            functionName: "decisionHandle",
            result: this.storedHandle,
          });
        case "isFinalized":
          return encodeFunctionResult({
            abi: policyVaultAbi,
            functionName: "isFinalized",
            result: this.finalized,
          });
        case "isApproved":
          return encodeFunctionResult({
            abi: policyVaultAbi,
            functionName: "isApproved",
            result: this.approved,
          });
        case "authorizationState":
          return encodeFunctionResult({
            abi: usdcAbi,
            functionName: "authorizationState",
            result: this.authorizationUsed,
          });
        default:
          throw new Error(`FakeChain: unhandled selector ${selector}`);
      }
    }
    throw new Error(`FakeChain: unhandled ${method}`);
  }
}

/**
 * Selectors for the views the verifier reads, derived from the ABIs rather than
 * hardcoded — a stale hex literal here would make the fake chain reject a call
 * the real chain answers, and the test would fail for the wrong reason.
 */
const SELECTORS: Record<string, string> = Object.fromEntries(
  [
    ...["decisionHandle", "isFinalized", "isApproved"].map(
      (name) => [selectorFor(policyVaultAbi, name), name] as const,
    ),
    [selectorFor(usdcAbi, "authorizationState"), "authorizationState"] as const,
  ],
);

function selectorFor(abi: readonly unknown[], name: string): Hex {
  const entry = (abi as ReadonlyArray<{ type?: string; name?: string }>).find(
    (item) => item.type === "function" && item.name === name,
  );
  if (!entry) throw new Error(`no function ${name} in ABI`);
  return toFunctionSelector(entry as AbiFunction);
}

/** A complete honest-then-bounced run, as the orchestrator would emit it. */
function buildTrace(overrides: { approved?: boolean } = {}): Trace {
  let clock = 1_800_000_000_000;
  const builder = new TraceBuilder({
    goalId: 7n,
    vault: VAULT,
    chainId: CHAIN_ID,
    now: () => (clock += 1000),
  });

  builder.record({ type: "request", url: "https://api.local/r", attempt: 1 });
  builder.record({
    type: "payment-required",
    url: "https://api.local/r",
    terms: {
      amount: 10_000n,
      payTo: "0x1111111111111111111111111111111111111111",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      resource: "https://api.local/r",
      description: "Premium feed.",
    },
  });
  builder.record({
    type: "agent-reasoning",
    reasoning: "Worth it.",
    modelSafeTerms: { amountAtomic: "10000" },
    decidedToRequest: true,
    source: "scripted",
  });
  builder.record({
    type: "spend-requested",
    goalId: 7n,
    spend: {
      seq: 1n,
      decisionHandle: HANDLE,
      termsHash: `0x${"dd".repeat(32)}`,
      validAfter: 1n,
      validBefore: 2n,
      commitTx: COMMIT_TX,
      gasUsed: 296_517n,
    },
  });
  builder.attachSignatures([`0x${"33".repeat(65)}`]);
  builder.record({
    type: "reveal-polled",
    attempts: 2,
    latencyMs: 6400,
    approved: overrides.approved ?? true,
  });
  builder.record({
    type: "decision-finalized",
    goalId: 7n,
    seq: 1n,
    approved: overrides.approved ?? true,
    txHash: FINALIZE_TX,
  });
  builder.record({ type: "signed", nonce: `0x${"ee".repeat(32)}`, value: "10000" });
  builder.record({
    type: "settled",
    settlement: {
      success: true,
      transaction: `0x${"99".repeat(32)}`,
      payer: "0x5555555555555555555555555555555555555555",
    },
  });
  builder.record({ type: "response-200", url: "https://api.local/r", fromCache: false });

  return builder.build();
}

let chain: FakeChain;

beforeEach(() => {
  chain = new FakeChain();
  chain.install();
});

describe("canonical serialisation", () => {
  it("is insensitive to key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("renders bigint as a decimal string", () => {
    expect(canonicalJson({ n: 10n ** 30n })).toBe(`{"n":"${10n ** 30n}"}`);
  });

  it("treats an explicitly-undefined key as absent", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe("merkle accumulator", () => {
  const leaves = Array.from({ length: 5 }, (_, i) => `0x${String(i).repeat(64)}` as Hex);

  it("produces a proof that verifies for every leaf", () => {
    const root = merkleRoot(leaves);
    for (const [i, leaf] of leaves.entries()) {
      expect(verifyMerkleProof(leaf, merkleProof(leaves, i), root)).toBe(true);
    }
  });

  it("rejects a proof for a value that is not in the tree", () => {
    const root = merkleRoot(leaves);
    expect(verifyMerkleProof(`0x${"ff".repeat(32)}`, merkleProof(leaves, 0), root)).toBe(false);
  });

  // Domain separation: without it an internal node can be passed off as a leaf.
  it("hashes leaves and internal nodes differently", () => {
    const a = `0x${"aa".repeat(32)}` as Hex;
    const b = `0x${"bb".repeat(32)}` as Hex;
    expect(hashLeaf(hashNode(a, b))).not.toBe(hashNode(a, b));
  });

  // Promotion rather than duplication: otherwise [a,b,b] and [a,b] collide.
  it("does not collide when the last leaf repeats", () => {
    const a = `0x${"aa".repeat(32)}` as Hex;
    const b = `0x${"bb".repeat(32)}` as Hex;
    expect(merkleRoot([a, b])).not.toBe(merkleRoot([a, b, b]));
  });
});

describe("verifyTrace", () => {
  it("validates a good trace offline", async () => {
    const result = await verifyTrace(buildTrace());
    expect(result.valid).toBe(true);
    expect(result.onChain).toBe(false);
    // Says so rather than silently passing a weaker check.
    expect(result.findings.some((f) => f.check === "onchain")).toBe(true);
  });

  it("validates a good trace against the chain", async () => {
    const result = await verifyTrace(buildTrace(), {
      rpcUrl: "http://127.0.0.1:1/fake",
      usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    });
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.onChain).toBe(true);
  });

  // Acceptance test 2.
  it("rejects a tampered step", async () => {
    const trace = buildTrace();
    const steps = [...trace.steps];
    const target = steps[1]!;
    // Change the price after the fact — the classic edit.
    steps[1] = {
      ...target,
      outputs: { ...(target.outputs as object), amount: "1" },
    };

    const result = await verifyTrace({ ...trace, steps });
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.check === "chain.hash" && f.step === 1)).toBe(true);
  });

  it("rejects a step removed from the middle", async () => {
    const trace = buildTrace();
    const steps = trace.steps.filter((_, i) => i !== 3);
    const result = await verifyTrace({ ...trace, steps });
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.check === "chain.link")).toBe(true);
  });

  it("rejects a rewritten root", async () => {
    const trace = buildTrace();
    const result = await verifyTrace({ ...trace, root: `0x${"00".repeat(32)}` });
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.check === "merkle.root")).toBe(true);
  });

  it("rejects a trace whose first step does not link to genesis", async () => {
    const trace = buildTrace();
    const steps = [...trace.steps];
    steps[0] = { ...steps[0]!, priorHash: `0x${"77".repeat(32)}` };
    const result = await verifyTrace({ ...trace, steps });
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.check === "chain.link" && f.step === 0)).toBe(true);
  });

  // Acceptance test 3 — the mandatory handle-match check from plan §2.6.
  it("rejects a swapped attestation", async () => {
    // The trace is internally consistent and every hash recomputes. The only
    // thing wrong is that its attestation names a handle the vault never
    // stored — precisely the substitution signature-checking alone would miss.
    chain.storedHandle = `0x${"be".repeat(32)}`;

    const result = await verifyTrace(buildTrace(), { rpcUrl: "http://127.0.0.1:1/fake" });
    expect(result.valid).toBe(false);
    const finding = result.findings.find((f) => f.check === "onchain.handleMatch");
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("wrong handle");
  });

  it("rejects a trace claiming approval the chain does not record", async () => {
    chain.approved = false;
    const result = await verifyTrace(buildTrace({ approved: true }), {
      rpcUrl: "http://127.0.0.1:1/fake",
    });
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.check === "onchain.decision")).toBe(true);
  });

  it("accepts a bounce, and checks it just as hard", async () => {
    chain.approved = false;
    const result = await verifyTrace(buildTrace({ approved: false }), {
      rpcUrl: "http://127.0.0.1:1/fake",
    });
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a commit tx that does not target the vault", async () => {
    chain.commitTxTo = "0x000000000000000000000000000000000000dEaD";
    const result = await verifyTrace(buildTrace(), { rpcUrl: "http://127.0.0.1:1/fake" });
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.check === "onchain.commitTx")).toBe(true);
  });

  it("warns, but does not fail, when a signed authorization was never consumed", async () => {
    // Stub settlement is a legitimate configuration, so this is a warning.
    chain.authorizationUsed = false;
    const result = await verifyTrace(buildTrace(), {
      rpcUrl: "http://127.0.0.1:1/fake",
      usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    });
    expect(result.valid).toBe(true);
    expect(result.findings.some((f) => f.severity === "warning" && f.check === "onchain.settlement")).toBe(true);
  });

  it("refuses a trace from a different chain", async () => {
    chain.chainId = 8453;
    const result = await verifyTrace(buildTrace(), { rpcUrl: "http://127.0.0.1:1/fake" });
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.check === "onchain.chainId")).toBe(true);
  });
});

describe("TraceBuilder", () => {
  it("links every step to the one before it, starting at genesis", () => {
    const trace = buildTrace();
    expect(trace.steps[0]!.priorHash).toBe(GENESIS_HASH);
    for (let i = 1; i < trace.steps.length; i++) {
      expect(trace.steps[i]!.priorHash).toBe(trace.steps[i - 1]!.hash);
    }
  });

  it("keeps the bounce in the trace", () => {
    const trace = buildTrace({ approved: false });
    const finalized = trace.steps.find((s) => s.type === "decision-finalized");
    expect(finalized?.attestation?.approved).toBe(false);
    expect(finalized?.attestation?.decisionHandle).toBe(HANDLE);
  });

  it("records the vendor's description verbatim", () => {
    const trace = buildTrace();
    const step = trace.steps.find((s) => s.type === "payment-required");
    expect((step?.outputs as { description: string }).description).toBe("Premium feed.");
  });

  it("is byte-stable for the same events", () => {
    expect(buildTrace().root).toBe(buildTrace().root);
  });
});
