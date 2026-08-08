// Untrusted orchestrator entry point. Populated starting M1 (x402 client) and M2 (payment path).
// Non-negotiable (IMPLEMENTATION.md §1.1): this package must never import @ntux402/signer or
// hold a payer key. Enforced by `pnpm check:boundary`.
export {};
