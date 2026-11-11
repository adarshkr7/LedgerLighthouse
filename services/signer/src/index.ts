/**
 * Authorization Signer **[ASSUMPTION]** — holds the per-goal ephemeral payer key
 * and signs collections through the auth-capture escrow, and nothing else.
 *
 * Its request schema carries `(goalId, seq)` only. Every field it signs is read
 * from the finalized on-chain record (ARCHITECTURE.md). `services/orchestrator` must
 * never import this package; enforced by `pnpm check:boundary`.
 */

export * from "./schema.js";
export * from "./keystore.js";
export * from "./vault.js";
export * from "./escrow-service.js";
export * from "./open-signer.js";
export * from "./http.js";
