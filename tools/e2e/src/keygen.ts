/**
 * Generates the throwaway Base Sepolia keys the demo needs, and prints them for
 * pasting into `.env`.
 *
 *   pnpm --filter @ntux402/e2e run keygen
 *
 * It prints rather than writes, deliberately: a tool that edits `.env` on your
 * behalf is a tool that can clobber a key you cared about.
 *
 * Two roles, neither of which may ever hold user funds:
 *
 *   ORCHESTRATOR_RELAY_KEY   pays gas for requestSpend / finalizeDecision
 *   FACILITATOR_PRIVATE_KEY  pays gas to submit transferWithAuthorization
 *
 * The **payer** key is deliberately absent. It is minted by the signer, per
 * goal, and never leaves it (IMPLEMENTATION.md §5.1). If you find yourself
 * wanting to add it here, the design has drifted.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROLES = [
  ["ORCHESTRATOR_RELAY_KEY", "gas for requestSpend/finalize — authorizes no payment"],
  ["FACILITATOR_PRIVATE_KEY", "gas for settlement — holds no user funds"],
] as const;

console.log("\nThrowaway Base Sepolia keys. Paste into .env, then fund each with a little ETH.\n");

for (const [name, note] of ROLES) {
  const key = generatePrivateKey();
  console.log(`# ${note}`);
  console.log(`${name}=${key}`);
  console.log(`#   -> ${privateKeyToAccount(key).address}\n`);
}

console.log("Fund them with `pnpm --filter @ntux402/e2e run fund`, or a faucet:");
console.log("  https://www.alchemy.com/faucets/base-sepolia\n");
console.log("Test USDC for the payer is a separate trip: https://faucet.circle.com\n");
