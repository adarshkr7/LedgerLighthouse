/**
 * The standalone verifier (ARCHITECTURE.md §8.4).
 *
 * Its defining constraint: **no dependency on our services beyond a public
 * RPC.** An auditor holding the trace file and any Base Sepolia endpoint can
 * run this. Nothing here calls the orchestrator, the signer, the facilitator or
 * the mock API, and nothing trusts a value the trace asserts about itself
 * without re-deriving it.
 *
 * Two layers of checking, and the split matters:
 *
 *  - **Offline** — the hash chain and the Merkle root. Catches any edit,
 *    reorder, insertion or truncation of the trace. Needs no network.
 *  - **On-chain** — the claims the trace makes about Base Sepolia. Catches a
 *    trace that is internally consistent but describes events that did not
 *    happen: a swapped attestation, an invented approval, a settled payment
 *    that never settled.
 *
 * The claim this supports is the narrow one from ARCHITECTURE.md §8.3 — every payment
 * corresponds to a confidential policy evaluation attested by Inco and verified
 * on chain against the expected handle. Not "the agent behaved correctly."
 */

import {
  createPublicClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { baseSepolia } from "viem/chains";
import { policyVaultAbi, usdcAbi } from "@ntux402/shared";

import { merkleRoot } from "./merkle.js";
import { GENESIS_HASH, computeStepHash, type Trace } from "./step.js";
import { rpcTransport } from "@ntux402/shared/viem";

export interface Finding {
  readonly severity: "error" | "warning";
  /** Absent for findings about the trace as a whole rather than one step. */
  readonly step?: number | undefined;
  readonly check: string;
  readonly detail: string;
}

export interface VerificationResult {
  readonly valid: boolean;
  readonly checksRun: number;
  readonly findings: readonly Finding[];
  readonly onChain: boolean;
}

export interface VerifyOptions {
  /** Omit to run offline-only. */
  readonly rpcUrl?: string;
  readonly client?: PublicClient;
  /** Cross-check settled authorizations against the token. */
  readonly usdcAddress?: Address;
}

export async function verifyTrace(
  trace: Trace,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  const findings: Finding[] = [];
  let checksRun = 0;

  const fail = (check: string, detail: string, step?: number) => {
    findings.push({ severity: "error", check, detail, ...(step === undefined ? {} : { step }) });
  };
  const warn = (check: string, detail: string, step?: number) => {
    findings.push({ severity: "warning", check, detail, ...(step === undefined ? {} : { step }) });
  };

  // ------------------------------------------------------------- structure
  checksRun++;
  if (trace.version !== 1) {
    fail("version", `unsupported trace version ${String(trace.version)}`);
    return { valid: false, checksRun, findings, onChain: false };
  }

  // --------------------------------------------------------- the hash chain
  let expectedPrior: Hex = GENESIS_HASH;
  for (const [i, step] of trace.steps.entries()) {
    checksRun++;
    if (step.index !== i) {
      fail("step.index", `step at position ${i} claims index ${step.index}`, i);
    }

    checksRun++;
    if (step.priorHash.toLowerCase() !== expectedPrior.toLowerCase()) {
      fail(
        "chain.link",
        `priorHash is ${step.priorHash}, expected ${expectedPrior} — the chain is broken here, ` +
          `which means a step was edited, inserted or removed at or before this point`,
        i,
      );
    }

    // The check that catches tampering: the hash is recomputed from the step's
    // own contents rather than believed.
    checksRun++;
    const recomputed = computeStepHash({
      index: step.index,
      type: step.type,
      timestamp: step.timestamp,
      inputs: step.inputs,
      outputs: step.outputs,
      priorHash: step.priorHash,
      ...(step.attestation ? { attestation: step.attestation } : {}),
    });
    if (recomputed.toLowerCase() !== step.hash.toLowerCase()) {
      fail(
        "chain.hash",
        `recomputed ${recomputed} but the trace claims ${step.hash} — this step's contents ` +
          `do not match its hash`,
        i,
      );
    }

    expectedPrior = step.hash;
  }

  // -------------------------------------------------------------- the root
  checksRun++;
  const root = merkleRoot(trace.steps.map((s) => s.hash));
  if (root.toLowerCase() !== trace.root.toLowerCase()) {
    fail("merkle.root", `recomputed ${root} but the trace claims ${trace.root}`);
  }

  // ------------------------------------------------------------- on chain
  const client =
    options.client ??
    (options.rpcUrl
      ? (createPublicClient({
          chain: baseSepolia,
          transport: rpcTransport(options.rpcUrl),
        }) as PublicClient)
      : undefined);

  if (!client) {
    warn(
      "onchain",
      "skipped — no RPC supplied. The hash chain is verified, but the trace's claims about " +
        "Base Sepolia are not.",
    );
    return { valid: !findings.some((f) => f.severity === "error"), checksRun, findings, onChain: false };
  }

  checksRun++;
  const chainId = await client.getChainId();
  if (chainId !== trace.chainId) {
    fail("onchain.chainId", `RPC is chain ${chainId}, the trace is for ${trace.chainId}`);
    return { valid: false, checksRun, findings, onChain: true };
  }

  for (const step of trace.steps) {
    const attestation = step.attestation;
    if (!attestation) continue;

    const goalId = BigInt(attestation.goalId);
    const seq = BigInt(attestation.seq);
    const vaultRead = { address: trace.vault, abi: policyVaultAbi, args: [goalId, seq] } as const;

    // **The mandatory check** (PRIMER.md §7.6, §7.5): the attested handle must equal
    // the handle the vault stored. A genuine attestation for a *different*
    // handle is otherwise substitutable, and signature validity alone would not
    // notice.
    checksRun++;
    try {
      const storedHandle = (await client.readContract({
        ...vaultRead,
        functionName: "decisionHandle",
      })) as Hex;
      if (storedHandle.toLowerCase() !== attestation.decisionHandle.toLowerCase()) {
        fail(
          "onchain.handleMatch",
          `the trace attests to handle ${attestation.decisionHandle}, but the vault stored ` +
            `${storedHandle} for (${goalId}, ${seq}) — a genuine attestation for the wrong handle ` +
            `is exactly what this check exists to reject`,
          step.index,
        );
      }
    } catch (e) {
      fail(
        "onchain.handleMatch",
        `could not read the decision handle: ${e instanceof Error ? e.message : String(e)}`,
        step.index,
      );
    }

    // The decision the trace reports must be the decision the chain recorded.
    checksRun++;
    try {
      const [finalized, approved] = (await Promise.all([
        client.readContract({ ...vaultRead, functionName: "isFinalized" }),
        client.readContract({ ...vaultRead, functionName: "isApproved" }),
      ])) as [boolean, boolean];
      if (!finalized) {
        fail(
          "onchain.finalized",
          `(${goalId}, ${seq}) is not finalized on chain, but the trace records a decision`,
          step.index,
        );
      }
      if (approved !== attestation.approved) {
        fail(
          "onchain.decision",
          `the trace records approved=${attestation.approved}, the chain says ${approved}`,
          step.index,
        );
      }
    } catch (e) {
      fail(
        "onchain.decision",
        `could not read the decision: ${e instanceof Error ? e.message : String(e)}`,
        step.index,
      );
    }

    // The commit transaction must exist and must be a call to this vault.
    checksRun++;
    try {
      const tx = await client.getTransaction({ hash: attestation.commitTx });
      if (tx.to?.toLowerCase() !== trace.vault.toLowerCase()) {
        fail(
          "onchain.commitTx",
          `commit ${attestation.commitTx} targets ${tx.to}, not the vault ${trace.vault}`,
          step.index,
        );
      }
    } catch (e) {
      fail(
        "onchain.commitTx",
        `commit ${attestation.commitTx} not found: ${e instanceof Error ? e.message : String(e)}`,
        step.index,
      );
    }
  }

  // A settled payment must actually have consumed its authorization. This is
  // what makes "the trace says it paid" checkable rather than assertable.
  const usdc = options.usdcAddress;
  if (usdc) {
    for (const step of trace.steps) {
      if (step.type !== "authorization-signed") continue;
      const outputs = step.outputs as { nonce?: Hex } | null;
      const nonce = outputs?.nonce;
      if (!nonce) continue;

      const payer = findPayer(trace);
      if (!payer) {
        warn("onchain.settlement", "no payer address in the trace; cannot check the nonce", step.index);
        continue;
      }

      checksRun++;
      try {
        const used = (await client.readContract({
          address: usdc,
          abi: usdcAbi,
          functionName: "authorizationState",
          args: [payer, nonce],
        })) as boolean;
        if (!used) {
          warn(
            "onchain.settlement",
            `authorization ${nonce} was signed but the token has not consumed it — either ` +
              `settlement was stubbed, or it never reached the chain`,
            step.index,
          );
        }
      } catch (e) {
        warn(
          "onchain.settlement",
          `could not read authorizationState: ${e instanceof Error ? e.message : String(e)}`,
          step.index,
        );
      }
    }
  }

  return {
    valid: !findings.some((f) => f.severity === "error"),
    checksRun,
    findings,
    onChain: true,
  };
}

/** The `from` of any signed authorization recorded in the trace. */
function findPayer(trace: Trace): Address | undefined {
  for (const step of trace.steps) {
    if (step.type !== "settled") continue;
    const settlement = step.outputs as { payer?: string } | null;
    if (settlement?.payer && /^0x[0-9a-fA-F]{40}$/.test(settlement.payer)) {
      return settlement.payer as Address;
    }
  }
  return undefined;
}
