/**
 * Runs the Authorization Signer against Base Sepolia.
 *
 *   pnpm --filter @ntux402/signer run start
 *
 * Reads BASE_SEPOLIA_RPC_URL, POLICY_VAULT_ADDRESS, USDC_ADDRESS, CHAIN_ID and
 * SIGNER_KEY_STORE_PATH. Deliberately does **not** read ORCHESTRATOR_RELAY_KEY:
 * this process has no business submitting transactions, and reading the variable
 * at all is the first step towards doing so.
 */

import { loadDotEnv, required, requiredAddress } from "@ntux402/shared/node";

import { openKeyStore } from "./keystore.js";
import { createSignerServer } from "./http.js";
import { AuthorizationSigner } from "./service.js";
import { OnChainVaultReader } from "./vault.js";

loadDotEnv();

const port = Number(process.env["SIGNER_PORT"] ?? 8402);
const chainId = Number(process.env["CHAIN_ID"] ?? 84532);

const vault = new OnChainVaultReader({
  rpcUrl: required("BASE_SEPOLIA_RPC_URL"),
  vaultAddress: requiredAddress("POLICY_VAULT_ADDRESS"),
});

const keys = openKeyStore(process.env["SIGNER_KEY_STORE_PATH"]);

const signer = new AuthorizationSigner({
  vault,
  keys,
  config: { chainId, usdcAddress: requiredAddress("USDC_ADDRESS") },
});

const server = createSignerServer({
  signer,
  log: (line) => console.log(`[signer] ${line}`),
});

server.listen(port, () => {
  console.log(`[signer] listening on http://127.0.0.1:${port}`);
  console.log(`[signer] chain ${chainId}, vault ${process.env["POLICY_VAULT_ADDRESS"]}`);
  console.log(
    `[signer] key store: ${process.env["SIGNER_KEY_STORE_PATH"] ?? "in-memory (keys lost on restart)"}`,
  );
});
