/**
 * Enrolls a payer for a goal the way the console does: a fresh id, the signer's
 * statement through `SignerClient`, and the console's own check of it against the
 * vault's `enrollmentSigner()`. The scripts open goals with what this returns.
 */

import type { Address, Hex, PublicClient } from "viem";
import type { SignerClient } from "@ntux402/orchestrator";
import { escrowPolicyVaultAbi } from "@ntux402/shared";
import { checkEnrollment, freshEnrollmentId } from "@ntux402/shared/viem";

export interface Enrolled {
  readonly payer: Address;
  readonly enrollmentId: Hex;
  readonly signature: Hex;
}

export async function enroll(options: {
  signer: Pick<SignerClient, "enroll">;
  reader: Pick<PublicClient, "readContract">;
  vault: Address;
  owner: Address;
  chainId: number;
}): Promise<Enrolled> {
  const enrollmentSigner = (await options.reader.readContract({
    address: options.vault,
    abi: escrowPolicyVaultAbi,
    functionName: "enrollmentSigner",
  })) as Address;
  const enrollmentId = freshEnrollmentId();
  const statement = await checkEnrollment(await options.signer.enroll(options.owner, enrollmentId), {
    owner: options.owner,
    enrollmentId,
    chainId: options.chainId,
    vault: options.vault,
    enrollmentSigner,
  });
  return { payer: statement.payer, enrollmentId, signature: statement.signature };
}
