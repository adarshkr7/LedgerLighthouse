/**
 * Authorization Signer **[ASSUMPTION]** — holds the per-goal ephemeral payer key
 * and signs EIP-3009 authorizations, and nothing else.
 *
 * Its request schema carries `(goalId, seq)` only. Every field it signs is read
 * from the finalized on-chain record (IMPLEMENTATION.md §1, non-negotiables 2
 * and 3). `services/orchestrator` must never import this package; enforced by
 * `pnpm check:boundary`.
 */

export * from "./schema.js";
export * from "./keystore.js";
export * from "./vault.js";
export * from "./service.js";
export * from "./http.js";
