/**
 * Which kind of signature this signer gives, decided once at boot.
 *
 * Never per request and never from the chain alone, because the danger is the mismatch.
 * EscrowPolicyVault still has PolicyVault's `authorization` view, so a direct signer
 * pointed at one would read a valid approval and sign a plain transfer, and every
 * guarantee that vault offers would be gone without anything looking wrong. So boot
 * refuses unless the mode and the vault agree, in both directions.
 *
 * This guards against a mistake and not an attack: an RPC lying at boot could pass it.
 * What holds against the RPC is that an escrow signer has no plain transfer to give,
 * so `SIGNER_SETTLEMENT` belongs in the measured compose file, not in a secret.
 */

import { isAddressEqual, type Address } from "viem";
import { AUTH_CAPTURE_ESCROW, ERC3009_TOKEN_COLLECTOR } from "@ntux402/shared";

import { EscrowAuthorizationSigner, type SignedEscrowAuthorization } from "./escrow-service.js";
import type { KeyStore } from "./keystore.js";
import { AuthorizationSigner, type SignedAuthorization, type SignerService } from "./service.js";
import type { EscrowVaultReader } from "./vault.js";

export type Settlement = "direct" | "escrow";

/** Unset means direct, which is every vault deployed so far. A typo refuses the boot. */
export function settlementFromEnv(raw: string | undefined): Settlement {
  if (raw === undefined || raw === "" || raw === "direct") return "direct";
  if (raw === "escrow") return "escrow";
  throw new Error(`SIGNER_SETTLEMENT must be "direct" or "escrow", not ${JSON.stringify(raw)}`);
}

export async function openSigner(options: {
  settlement: Settlement;
  vault: EscrowVaultReader;
  keys: KeyStore;
  chainId: number;
  usdcAddress: Address;
  vaultAddress: Address;
  /** Pinned constants in production. Injected only so a test can use its own. */
  escrow?: Address;
  collector?: Address;
}): Promise<SignerService<SignedAuthorization | SignedEscrowAuthorization>> {
  const { settlement, vault, keys, chainId, usdcAddress, vaultAddress } = options;
  const escrow = options.escrow ?? AUTH_CAPTURE_ESCROW;
  const collector = options.collector ?? ERC3009_TOKEN_COLLECTOR;
  const binding = await vault.escrowBinding();

  if (settlement === "direct") {
    if (binding) {
      throw new Error(
        `SIGNER_SETTLEMENT is direct but ${vaultAddress} is an escrow vault. A direct signer would ` +
          `sign plain transfers against it and undo what it guarantees. Set SIGNER_SETTLEMENT=escrow.`,
      );
    }
    return new AuthorizationSigner({ vault, keys, config: { chainId, usdcAddress } });
  }

  if (!binding) {
    throw new Error(
      `SIGNER_SETTLEMENT is escrow but ${vaultAddress} has no escrow. It would refuse every signature. ` +
        `Point POLICY_VAULT_ADDRESS at an EscrowPolicyVault.`,
    );
  }
  if (!isAddressEqual(binding.escrow, escrow) || !isAddressEqual(binding.collector, collector)) {
    throw new Error(
      `the vault uses escrow ${binding.escrow} and collector ${binding.collector}, but this signer ` +
        `signs only for ${escrow} and ${collector}.`,
    );
  }
  return new EscrowAuthorizationSigner({
    vault,
    keys,
    config: { chainId, usdcAddress, vaultAddress, escrow, collector },
  });
}
