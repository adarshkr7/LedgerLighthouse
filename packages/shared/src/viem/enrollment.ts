/**
 * The console's check of an enrollment statement, before it opens a goal or
 * funds a payer.
 *
 * The statement arrives through the orchestrator, which the threat model assumes
 * is compromised. Everything the console relies on is therefore checked against
 * values the orchestrator cannot choose: the owner is the connected wallet, the
 * enrollment id is the one the console just drew, the chain and vault are fixed
 * at build time, and the signer is the enrollment key pinned at build time and
 * read from the vault itself. A statement that passes says the attested signer
 * derived this payer for this wallet, and the vault will refuse any other.
 */

import { isAddressEqual, recoverTypedDataAddress, type Address, type Hex } from "viem";

import { ENROLLMENT_TYPES, enrollmentDomain, type EnrollmentStatement } from "../chain/escrow.js";

export interface ExpectedEnrollment {
  readonly owner: Address;
  readonly enrollmentId: Hex;
  readonly chainId: number;
  readonly vault: Address;
  /** The enrollment key the console trusts: pinned at build time and equal to the vault's. */
  readonly enrollmentSigner: Address;
}

const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isBytes32 = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

/**
 * Returns the statement if it holds, and throws with the reason if it does not.
 * The reason names the field, never asks the user to judge.
 */
export async function checkEnrollment(raw: unknown, expected: ExpectedEnrollment): Promise<EnrollmentStatement> {
  if (typeof raw !== "object" || raw === null) throw new Error("the enrollment statement is not an object");
  const s = raw as Partial<Record<keyof EnrollmentStatement, unknown>>;
  if (!isAddress(s.payer) || !isAddress(s.owner) || !isAddress(s.vault) || !isAddress(s.enrollmentSigner)) {
    throw new Error("the enrollment statement is malformed");
  }
  if (!isBytes32(s.enrollmentId) || typeof s.chainId !== "number" || typeof s.signature !== "string") {
    throw new Error("the enrollment statement is malformed");
  }
  if (!isAddressEqual(s.owner, expected.owner)) {
    throw new Error(`the statement enrolls the payer for ${s.owner}, not for this wallet`);
  }
  if (s.enrollmentId.toLowerCase() !== expected.enrollmentId.toLowerCase()) {
    throw new Error("the statement is for another enrollment id, not the one this page drew");
  }
  if (s.chainId !== expected.chainId || !isAddressEqual(s.vault, expected.vault)) {
    throw new Error("the statement is for another chain or vault");
  }
  if (!isAddressEqual(s.enrollmentSigner, expected.enrollmentSigner)) {
    throw new Error(`the statement claims enrollment key ${s.enrollmentSigner}, not the pinned one`);
  }
  const recovered = await recoverTypedDataAddress({
    // Lowercased: an all-lowercase address is valid whatever the source's checksum.
    domain: enrollmentDomain(expected.chainId, expected.vault.toLowerCase() as Address),
    types: ENROLLMENT_TYPES,
    primaryType: "Enrollment",
    message: {
      payer: s.payer.toLowerCase() as Address,
      owner: expected.owner.toLowerCase() as Address,
      enrollmentId: expected.enrollmentId,
    },
    signature: s.signature as Hex,
  }).catch(() => undefined);
  if (!recovered || !isAddressEqual(recovered, expected.enrollmentSigner)) {
    throw new Error("the enrollment statement is not signed by the pinned enrollment key");
  }
  return s as EnrollmentStatement;
}

/** 32 random bytes for a new enrollment, from the platform's CSPRNG. */
export function freshEnrollmentId(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
