// Untrusted orchestrator. LLM + x402 client + the payment loop.
//
// Non-negotiable (IMPLEMENTATION.md §1.1): this package must never import
// @ntux402/signer and must never hold a payer key. It holds the *relay* key,
// which pays gas for requestSpend/finalize and authorizes no payment.
// Enforced by `pnpm check:boundary`.
export * from "./x402/index.js";
export * from "./inco/index.js";
export * from "./pay/index.js";
export * from "./agent/index.js";
export * from "./render.js";
export * from "./server.js";
