import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import { ENROLLMENT_TYPES, enrollmentDomain } from "../chain/escrow.js";
import { checkEnrollment, freshEnrollmentId } from "./enrollment.js";

const ENROLLMENT = privateKeyToAccount(`0x${"e1".repeat(32)}`);
const ATTACKER = privateKeyToAccount(`0x${"ba".repeat(32)}`);
const OWNER: Address = "0x000000000000000000000000000000000000a11c";
const PAYER: Address = "0x0000000000000000000000000000000000004444";
const THIEF_PAYER: Address = "0x000000000000000000000000000000000000bad0";
const VAULT: Address = "0x00000000000000000000000000000000000ab0b1";
const CHAIN_ID = 84532;
const ID: Hex = `0x${"ab".repeat(32)}`;

const expected = { owner: OWNER, enrollmentId: ID, chainId: CHAIN_ID, vault: VAULT, enrollmentSigner: ENROLLMENT.address };

async function statement(over: { signer?: typeof ENROLLMENT; payer?: Address; owner?: Address; vault?: Address } = {}) {
  const signer = over.signer ?? ENROLLMENT;
  const message = { payer: over.payer ?? PAYER, owner: over.owner ?? OWNER, enrollmentId: ID };
  const signature = await signer.signTypedData({
    domain: enrollmentDomain(CHAIN_ID, over.vault ?? VAULT),
    types: ENROLLMENT_TYPES,
    primaryType: "Enrollment",
    message,
  });
  return { ...message, chainId: CHAIN_ID, vault: VAULT, enrollmentSigner: signer.address, signature };
}

describe("checkEnrollment", () => {
  it("accepts the pinned key's statement for this wallet", async () => {
    expect((await checkEnrollment(await statement(), expected)).payer).toBe(PAYER);
  });

  it("refuses an orchestrator's own payer, signed by its own key", async () => {
    const forged = await statement({ signer: ATTACKER, payer: THIEF_PAYER });
    await expect(checkEnrollment(forged, expected)).rejects.toThrow(/not the pinned one/);
    await expect(checkEnrollment({ ...forged, enrollmentSigner: ENROLLMENT.address }, expected)).rejects.toThrow(
      /not signed by the pinned enrollment key/,
    );
  });

  it("refuses a genuine statement with the payer swapped", async () => {
    const genuine = await statement();
    await expect(checkEnrollment({ ...genuine, payer: THIEF_PAYER }, expected)).rejects.toThrow(/not signed/);
  });

  it("refuses a statement for another owner, id, vault or chain", async () => {
    await expect(checkEnrollment(await statement({ owner: PAYER }), expected)).rejects.toThrow(/not for this wallet/);
    await expect(checkEnrollment(await statement(), { ...expected, enrollmentId: `0x${"cd".repeat(32)}` })).rejects.toThrow(
      /another enrollment id/,
    );
    await expect(checkEnrollment({ ...(await statement()), chainId: 1 }, expected)).rejects.toThrow(/another chain/);
    await expect(checkEnrollment(await statement({ vault: PAYER }), expected)).rejects.toThrow(/not signed/);
  });

  it("refuses malformed input", async () => {
    await expect(checkEnrollment(null, expected)).rejects.toThrow(/not an object/);
    await expect(checkEnrollment({ payer: "0x12" }, expected)).rejects.toThrow(/malformed/);
    await expect(checkEnrollment({ ...(await statement()), signature: "0xdead" }, expected)).rejects.toThrow(/not signed/);
  });
});

describe("freshEnrollmentId", () => {
  it("draws 32 bytes, differently each time", () => {
    const a = freshEnrollmentId();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(freshEnrollmentId()).not.toBe(a);
  });
});
