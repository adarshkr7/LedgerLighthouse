// Untrusted orchestrator. M1 ships the x402 v1 control flow; the payment path
// arrives in M2.
//
// Non-negotiable (IMPLEMENTATION.md §1.1): this package must never import
// @ntux402/signer or hold a payer key. Enforced by `pnpm check:boundary`.
export * from "./x402/index.js";
