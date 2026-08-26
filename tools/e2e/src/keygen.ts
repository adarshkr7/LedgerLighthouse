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
 * goal, and never leaves it (ARCHITECTURE.md). If you find yourself
 * wanting to add it here, the design has drifted.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROLES = [
  ["ORCHESTRATOR_RELAY_KEY", "gas for requestSpend/finalize — authorizes no payment"],
  ["FACILITATOR_PRIVATE_KEY", "gas for settlement — holds no user funds"],
  /*
   * The odd one out, and worth saying why.
   *
   * The two above are gas-only and must never hold user funds. This one is the
   * opposite: it is the vendor's revenue address and USDC lands in it on every
   * settled call. It is here because the alternative people reach for is their
   * own MetaMask address — which works, and makes the agent pay the person who
   * funded it. Circular, and the first thing an audience notices.
   *
   * Keep this key. Nothing in the system sweeps the vendor payee: `sweepGoal`
   * returns the *payer's* balance to the goal owner, and money paid to a vendor
   * has left that path for good. An address whose key you lose is USDC you
   * cannot retrieve.
   */
  ["VENDOR_AISA_PAYEE", "receives vendor revenue — KEEP THIS KEY, nothing sweeps it"],
] as const;

console.log("\nThrowaway Base Sepolia keys. Paste into .env, then fund each with a little ETH.\n");

for (const [name, note] of ROLES) {
  const key = generatePrivateKey();
  const { address } = privateKeyToAccount(key);
  console.log(`# ${note}`);

  if (name === "VENDOR_AISA_PAYEE") {
    // This variable wants the *address* — the vendor advertises it as `payTo`
    // and the console allowlists it. The key is what you keep, somewhere that
    // is not this repo, so the revenue can be swept later.
    console.log(`${name}=${address}`);
    console.log(`#   private key — NOT for .env. Store it to sweep this address:`);
    console.log(`#   ${key}\n`);
  } else {
    console.log(`${name}=${key}`);
    console.log(`#   -> ${address}\n`);
  }
}

console.log("Fund them with `pnpm --filter @ntux402/e2e run fund`, or a faucet:");
console.log("  https://www.alchemy.com/faucets/base-sepolia\n");
console.log("Test USDC for the payer is a separate trip: https://faucet.circle.com\n");
