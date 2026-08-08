# Inco-Bound Agent Payment Flow

An autonomous AI agent that pays for API resources over x402, where the spending policy is enforced
by confidential computation on Inco rather than by the agent itself.

> **Compromise of the AI orchestrator must not confer arbitrary spending authority.**

- Architecture / source of truth: [`inco-agent-payment-plan.md`](inco-agent-payment-plan.md)
- Ordered build brief: [`IMPLEMENTATION.md`](IMPLEMENTATION.md)

**Current milestone: M0 complete.** Skeleton, toolchain and the orchestrator↛signer boundary are in
place. No behaviour yet.

---

## Layout

```
contracts/              Foundry — PolicyVault, TraceAnchor, deploy scripts, tests
packages/shared/        TS types shared across services: terms schema, termsHash, ABIs
services/orchestrator/  Untrusted. LLM + x402 client. Holds NO keys.
services/signer/        Trusted [ASSUMPTION]. Holds the per-goal payer key. Reads chain only.
services/trace/         Hash chain, Merkle accumulator, standalone verifier CLI
apps/web/               MetaMask UI: open goal, fund, watch, verify
mock-api/               x402-priced endpoint with an honest and a malicious mode
```

## Prerequisites

- **Node 22+** and **pnpm 11** (pinned via `packageManager`; `corepack enable` picks it up).
- **Foundry** — install with `curl -L https://foundry.paradigm.xyz | bash && foundryup`.
  Verified against forge 1.7.1.

## Setup

```sh
pnpm install --ignore-scripts
cp .env.example .env      # then fill in
```

`--ignore-scripts` is deliberate: the git-hosted Solidity dependencies (`forge-std`, `ds-test`,
`safe-smart-account`) declare JS build scripts we do not need — we consume only their `.sol`
sources through Foundry remappings.

## Verify the toolchain

```sh
pnpm typecheck        # all TS packages
pnpm check:boundary   # orchestrator must not import the signer
cd contracts && forge build && forge test
```

## The key boundary

`services/orchestrator` must never import `services/signer`, by relative path or by package name.
`scripts/check-boundary.mjs` enforces this and runs in CI. This is the security property the whole
demo rests on — see IMPLEMENTATION.md §1, non-negotiable #1.

The orchestrator does legitimately hold the **relay key** (`ORCHESTRATOR_RELAY_KEY`), which pays gas
for `requestSpend`/`finalize` and authorizes no payment. The boundary check therefore targets import
paths, not the mere presence of a signing library.

## Faucets

Base Sepolia ETH (gas) and test USDC are **separate faucet trips**:

- ETH: <https://www.alchemy.com/faucets/base-sepolia> or the Coinbase Developer Platform faucet
- USDC: <https://faucet.circle.com> (select Base Sepolia)

## Verified facts

Resolved during Phase 0 against the published packages, so they no longer need re-verification:

| Item | Value |
|---|---|
| `@inco/lightning` (Solidity) | `1.0.2`; import path `@inco/lightning/src/Lib.sol` |
| `@inco/lightning-js` (TS) | `1.0.2`; peer dep viem `^2.39.3` |
| Inco Lightning executor (Base Sepolia + mainnet) | `0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624` |
| Inco Verifier | `0x867758FFe098fB0D74826A8DCf60127696440f09` |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals, domain `name: "USDC"`, `version: "2"` |
| solc / evm | `0.8.29`, `cancun` (matches Inco's own template) |

See IMPLEMENTATION.md §7 for the remaining `[OPEN — VERIFY WITH INCO DOCS]` register.

## Protocol version

`X402_VERSION` is **not yet pinned**. M1 decides v1 vs v2 — they differ in header names
(`X-PAYMENT` vs `PAYMENT-REQUIRED`) and in whether `network` is CAIP-2. The choice gets recorded
here and the mock API speaks only that version.
