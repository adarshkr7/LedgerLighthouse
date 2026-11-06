/**
 * Opens the signer, once it knows the vault is one it can serve.
 *
 * This signer can only sign through the escrow, so a vault with no escrow would refuse
 * every signature, and a vault using another escrow or collector would be a vault this
 * signer's signatures are not good for. Either is a mistake to report at boot and not
 * from the first payment.
 *
 * It guards against a mistake and not an attack: an RPC lying at boot could pass it.
 * What holds against the RPC is that this signer has no plain transfer to give.
 */

import { isAddressEqual, type Address } from "viem";
import { AUTH_CAPTURE_ESCROW, ERC3009_TOKEN_COLLECTOR } from "@ntux402/shared";

import { EscrowAuthorizationSigner } from "./escrow-service.js";
import type { KeyStore } from "./keystore.js";
import type { VaultReader } from "./vault.js";

export async function openSigner(options: {
  vault: VaultReader;
  keys: KeyStore;
  chainId: number;
  usdcAddress: Address;
  vaultAddress: Address;
  /** Pinned constants in production. Injected only so a test can use its own. */
  escrow?: Address;
  collector?: Address;
}): Promise<EscrowAuthorizationSigner> {
  const { vault, keys, chainId, usdcAddress, vaultAddress } = options;
  const escrow = options.escrow ?? AUTH_CAPTURE_ESCROW;
  const collector = options.collector ?? ERC3009_TOKEN_COLLECTOR;

  const binding = await vault.escrowBinding();
  if (!binding) {
    throw new Error(
      `${vaultAddress} has no escrow, and this signer can only sign through one, so it would refuse ` +
        `every signature. Point POLICY_VAULT_ADDRESS at an EscrowPolicyVault.`,
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
