/**
 * What the operator scripts share now that a vault spends through the auth-capture
 * escrow: refusing a vault of the other kind, finding the vendor to allowlist, reading
 * where a payment's money is, and getting decisions.
 */

import {
  encodeAbiParameters,
  isAddress,
  isAddressEqual,
  numberToHex,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { escrowPolicyVaultAbi } from "@ntux402/shared";
import {
  IncoDecisionReader,
  type AttestedDecision,
  type DecisionReader,
  type LightningZap,
} from "@ntux402/orchestrator";

import { optional } from "./config.js";

/**
 * How long a vendor has to claim after the hold ends, on requests a script makes
 * without a vendor's quote. A vendor's real deadline comes from its 402.
 */
export const CAPTURE_WINDOW_SECONDS = 600;
export const NO_KEY_HASH: Hex = `0x${"00".repeat(32)}`;

const escrowStateAbi = parseAbi([
  "function getHash((address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256)) view returns (bytes32)",
  "function paymentState(bytes32) view returns (bool, uint120, uint120)",
]);

/**
 * These scripts only speak to an EscrowPolicyVault, whose `requestSpend` always reverts.
 * Failing here says why, where the first request would only say it reverted.
 */
export async function assertEscrowVault(client: PublicClient, vault: Address): Promise<void> {
  const operated = await client
    .readContract({ address: vault, abi: escrowPolicyVaultAbi, functionName: "escrow" })
    .catch(() => undefined);
  if (operated === undefined) {
    throw new Error(
      `${vault} is not an EscrowPolicyVault: it has no escrow() to read. These scripts spend through ` +
        `the escrow. Deploy one and set POLICY_VAULT_ADDRESS, or use the arxiv-v1.1 tag for the old vault.`,
    );
  }
}

/**
 * The address the mock vendor is paid at, which a goal must allowlist. The catalog's
 * payees are placeholders nobody holds a key for, and a vendor must send its own `claim`.
 */
export async function mockVendor(mockApiUrl: string, vault: Address): Promise<Address> {
  const health = (await fetch(`${mockApiUrl}/health`)
    .then((r) => r.json())
    .catch(() => undefined)) as { settlement?: unknown; vendor?: unknown; vault?: unknown } | undefined;
  if (health === undefined) throw new Error(`the mock vendor is not reachable at ${mockApiUrl}. Start it first.`);
  if (health.settlement !== "escrow" || typeof health.vendor !== "string" || !isAddress(health.vendor)) {
    throw new Error(`the mock vendor at ${mockApiUrl} is not selling through the escrow. Restart it on the current code.`);
  }
  if (typeof health.vault !== "string" || !isAddress(health.vault) || !isAddressEqual(health.vault, vault)) {
    throw new Error(`the mock vendor names vault ${String(health.vault)}, not ${vault}. Restart it on the current .env.`);
  }
  return health.vendor;
}

/**
 * Refuses a signer that is not the escrow-only build, or reads another vault. Such a signer
 * would sign plain transfers against an escrow vault and undo what it guarantees.
 */
export async function assertEscrowSigner(signerUrl: string, vault: Address): Promise<void> {
  const health = (await fetch(`${signerUrl}/health`)
    .then((r) => r.json())
    .catch(() => undefined)) as { settlement?: unknown; vault?: unknown } | undefined;
  if (health === undefined) throw new Error(`the signer is not reachable at ${signerUrl}. Start it first.`);
  if (health.settlement !== "escrow") {
    throw new Error(`the signer at ${signerUrl} does not report escrow settlement, so it is an older build. Rebuild it.`);
  }
  if (typeof health.vault !== "string" || !isAddress(health.vault) || !isAddressEqual(health.vault, vault)) {
    throw new Error(`the signer reads vault ${String(health.vault)}, not ${vault}. Restart it with this vault.`);
  }
}

export interface PaymentState {
  /** The escrow took the money from the payer at some point. */
  readonly collected: boolean;
  /** Sitting in the escrow now. A reclaim after the capture deadline returns it. */
  readonly held: bigint;
  /** Paid to the vendor. */
  readonly captured: bigint;
}

/** Where the money of an approved spend is, from the escrow's own state. */
export async function paymentState(client: PublicClient, vault: Address, goalId: bigint, seq: bigint): Promise<PaymentState> {
  const read = { address: vault, abi: escrowPolicyVaultAbi } as const;
  const escrow = await client.readContract({ ...read, functionName: "escrow" });
  const p = await client.readContract({ ...read, functionName: "escrowPayment", args: [goalId, seq] });
  const hash = await client.readContract({
    address: escrow,
    abi: escrowStateAbi,
    functionName: "getHash",
    args: [
      [
        p.operator,
        p.payer,
        p.receiver,
        p.token,
        p.maxAmount,
        p.preApprovalExpiry,
        p.authorizationExpiry,
        p.refundExpiry,
        p.minFeeBps,
        p.maxFeeBps,
        p.feeReceiver,
        p.salt,
      ],
    ],
  });
  const [collected, held, captured] = await client.readContract({
    address: escrow,
    abi: escrowStateAbi,
    functionName: "paymentState",
    args: [hash],
  });
  return { collected, held, captured };
}

// --------------------------------------------------------------------- decisions

export interface DecisionSource extends DecisionReader {
  /** Tells a fork's stand-in the limits of a goal this process opened. */
  limits(goalId: bigint, budget: bigint, cap: bigint): void;
}

/** A fork's attestation for a decision. See contracts/test/ForkVerifier.sol. */
export function forkAttestation(handle: Hex, approved: boolean): Hex {
  return encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }],
    [handle, numberToHex(approved ? 1 : 0, { size: 32 })],
  );
}

/**
 * Inco, unless FORK_DECISIONS_FROM_BLOCK says this is the local fork in fork-tools.ts,
 * which has no covalidators.
 *
 * The stand-in applies the policy to the limits it was told, in the clear, so a run on
 * the fork says nothing about the encrypted comparison. It could not fool a real
 * network: its attestations only verify where ForkVerifier replaced Inco's verifier,
 * and this refuses to run against anything but an Anvil on this machine.
 */
export async function decisionSource(zap: LightningZap, client: PublicClient, vault: Address): Promise<DecisionSource> {
  const fromBlock = optional("FORK_DECISIONS_FROM_BLOCK");
  if (fromBlock === undefined) {
    const inco = new IncoDecisionReader(zap);
    return { read: (handle) => inco.read(handle), limits: () => undefined };
  }
  const version = await client.request({ method: "web3_clientVersion" } as never);
  const host = new URL(optional("RPC_URL") ?? "http://unset").hostname;
  if (!/anvil/i.test(String(version)) || (host !== "127.0.0.1" && host !== "localhost")) {
    throw new Error(`FORK_DECISIONS_FROM_BLOCK is set, but RPC_URL is ${host} (${String(version)}), not a local Anvil.`);
  }

  const remaining = new Map<bigint, { budget: bigint; cap: bigint }>();
  const decided = new Map<Hex, AttestedDecision>();
  const read = { address: vault, abi: escrowPolicyVaultAbi } as const;
  return {
    limits: (goalId, budget, cap) => void remaining.set(goalId, { budget, cap }),
    read: async (handle) => {
      const known = decided.get(handle);
      if (known) return known;
      const logs = await client.getContractEvents({
        ...read,
        eventName: "SpendRequested",
        fromBlock: BigInt(fromBlock),
      });
      const spend = logs.find((log) => log.args.decisionHandle === handle)?.args;
      if (!spend) return undefined;
      const limits = remaining.get(spend.goalId!);
      if (!limits) throw new Error(`the fork's stand-in was not told the limits of goal ${spend.goalId}`);
      const goal = (await client.readContract({ ...read, functionName: "goals", args: [spend.goalId!] })) as readonly unknown[];
      const amount = spend.amount!;
      const approved = Number(goal[4]) > 0 && amount <= limits.cap && amount <= limits.budget;
      if (approved) limits.budget -= amount;
      const decision = { approved, signatures: [forkAttestation(handle, approved)] };
      decided.set(handle, decision);
      return decision;
    },
  };
}
