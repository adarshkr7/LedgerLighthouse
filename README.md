# Inco-Bound Agent Payment Flow

An autonomous AI agent that pays for API resources over x402, where the spending policy is enforced
by confidential computation on Inco rather than by the agent itself.

> **Compromise of the AI orchestrator must not confer arbitrary spending authority.**

- Architecture / source of truth: [`inco-agent-payment-plan.md`](inco-agent-payment-plan.md)
- Ordered build brief: [`IMPLEMENTATION.md`](IMPLEMENTATION.md)

**Status: M0–M6 complete.** Verified end to end on Base Sepolia — the agent is manipulated by a
prompt injection, `requestSpend` lands on chain, Inco rejects it, and the signer is never asked.

---

## The 60-second version

```sh
pnpm install --ignore-scripts
cp .env.example .env          # fill in RPC + keys; see Setup
pnpm dev                      # starts every service
```

Then open <http://127.0.0.1:5173>, connect MetaMask on Base Sepolia, and walk the five steps.

---

## Layout

```
contracts/              Foundry — PolicyVault, TraceAnchor, deploy scripts, tests
packages/shared/        TS types across services: x402 schema, ABIs, USDC/EIP-3009 constants
services/orchestrator/  Untrusted. LLM + x402 client + payment loop. Relay key only.
services/signer/        Trusted [ASSUMPTION]. Holds the per-goal payer key. Reads chain only.
services/facilitator/   Self-hosted x402 v1 facilitator. Outside the trust boundary.
services/trace/         Hash chain, Merkle accumulator, standalone verifier CLI
apps/web/               MetaMask UI: open goal, fund, watch, verify
mock-api/               x402-priced endpoint with an honest and a malicious mode
tools/e2e/              Operator scripts: keygen, fund, balances, state, demo
```

## Who holds which key

This table is the security design, not a deployment detail.

| Key | Holder | Signs | Can it move your money? |
|---|---|---|---|
| **User** | MetaMask | `openGoal`, the USDC funding transfer, goal closure | Yes — it's yours |
| **Payer** | Authorization Signer, per goal, ephemeral | EIP-3009 `transferWithAuthorization` | Only what the chain already approved |
| **Relay** | Orchestrator | `requestSpend`, `finalizeDecision` — **gas only** | No |
| **Facilitator** | Facilitator (infrastructure) | Submits the settlement tx — **gas only** | No |

`services/orchestrator` must never import `services/signer`, by package name or relative path.
`scripts/check-boundary.mjs` enforces it in CI. That check is the whole demo's load-bearing wall.

---

## Prerequisites

- **Node 22+** and **pnpm 11** (pinned via `packageManager`; `corepack enable` picks it up).
- **Foundry** — `curl -L https://foundry.paradigm.xyz | bash && foundryup`. Verified on forge 1.7.1.
- A Base Sepolia RPC URL.

## Setup

```sh
pnpm install --ignore-scripts
cp .env.example .env
```

`--ignore-scripts` is deliberate: the git-hosted Solidity dependencies (`forge-std`, `ds-test`,
`safe-smart-account`) declare JS build scripts we do not need — we consume only their `.sol`
sources through Foundry remappings.

Then generate and fund the two gas-only roles:

```sh
pnpm --filter @ntux402/e2e run keygen     # prints keys to paste into .env
pnpm --filter @ntux402/e2e run fund       # sends them ETH from your account
pnpm --filter @ntux402/e2e run balances   # confirm
```

**Two faucet trips, and they are separate:**

- Base Sepolia ETH (gas): <https://www.alchemy.com/faucets/base-sepolia>
- Test USDC (the actual payments): <https://faucet.circle.com>, select Base Sepolia

Without test USDC everything still runs — the mock API falls back to **stub settlement**, which
validates payment payloads but moves no money and labels every response `simulated: true`. The
confidential policy, the decision and the bounce are real either way.

## Running it

```sh
pnpm dev
```

Starts the signer (8402), mock API (4021), orchestrator (8404), the web UI (5173), and — only if
`X402_FACILITATOR_URL` is set — the facilitator (8403). Ctrl-C stops all of them.

Headless equivalent, which is also the fastest way to check everything works:

```sh
pnpm --filter @ntux402/e2e run demo
```

## Before you push

```sh
pnpm verify                    # runs exactly what CI runs
pnpm verify --skip-contracts   # TS only, if Foundry isn't installed
```

Enable the pre-push hook once per clone: `git config core.hooksPath .githooks`.

---

## Verified facts

Resolved against the published packages and live chain, so they no longer need re-verification:

| Item | Value |
|---|---|
| `@inco/lightning` (Solidity) | `1.0.2`; import path `@inco/lightning/src/Lib.sol` |
| `@inco/lightning-js` (TS) | `1.0.2`; peer dep viem `^2.39.3` |
| Inco Lightning executor (Base Sepolia + mainnet) | `0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624` |
| Inco Verifier | `0x867758FFe098fB0D74826A8DCf60127696440f09` |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals, domain `name: "USDC"`, `version: "2"` |
| solc / evm | `0.8.29`, `cancun` (matches Inco's own template) |
| **PolicyVault (deployed)** | `0x0C759D06a1c14F43852D7b078Db2f8C342F15921` |

### Register item 3 — answered

**`attestedReveal` latency after `requestSpend` confirms: 6–10 seconds**, 1–2 poll attempts,
measured repeatedly on Base Sepolia. The SDK reports `ciphertext … not found, try again later`
while the compute server catches up. A *rejected* decision was consistently slower than an approved
one (10.0s vs 6.4s) — worth knowing for demo pacing.

Polling is bounded at 180s and a timeout is a **reported outcome**, not a swallowed exception: the
debit has already committed, so "decision unavailable" is a different state from "rejected" and
conflating them would misreport where the money went.

### Register item 10 — answered

Resolved by not needing the answer: `services/facilitator` is a self-hosted x402 v1 facilitator that
speaks the version we pinned. Its interface (`POST /verify`, `POST /settle`, `GET /supported`)
matches the hosted shape, so swapping to Coinbase's is a URL change.

## Protocol version — pinned to x402 **v1**

| | v1 (**ours**) | v2 (not used) |
|---|---|---|
| Request header | `X-PAYMENT` | `PAYMENT-SIGNATURE` |
| Response header | `X-PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` |
| 402 header | — | `PAYMENT-REQUIRED` |
| `network` | slug — `base-sepolia` | CAIP-2 — `eip155:84532` |

The mock API speaks only v1, and the parser rejects a v2-shaped body rather than adapting to it.
Constants live in [packages/shared/src/x402/protocol.ts](packages/shared/src/x402/protocol.ts).

The amount field on the wire is **`maxAmountRequired`**, never `amount`. Our internal `Terms.amount`
is derived from it, and the two names are kept distinct on purpose so a parser bug cannot silently
substitute one for the other.

---

## Verifying a trace

Every run produces a hash-chained trace with a Merkle root. The verifier needs the file and a public
RPC — nothing else, by design:

```sh
curl -s http://127.0.0.1:8404/traces/6 -o trace.json
pnpm --filter @ntux402/trace run verify -- trace.json
```

It re-derives every step hash, recomputes the root, and cross-checks each attestation against
`PolicyVault`: the attested handle must equal **the handle the vault stored**, and the recorded
decision must equal the on-chain one. Signature validity alone is insufficient — a genuine
attestation for a different handle is otherwise substitutable.

## Demo runbook

1. Connect MetaMask, switch to Base Sepolia.
2. Mint the ephemeral payer — **before** opening the goal, because the payer address is a field of
   the goal record.
3. Open the goal. Show the budget handle on Basescan: an opaque `bytes32`.
4. Fund the payer with slightly **more** than the encrypted budget, so Inco binds first.
5. **Run 1, honest 402** — request, price, approve, settle, data returns.
6. **Run 2, malicious 402** — inflated price plus injection. Show the agent complying. Show the
   commit transaction landing. Show the decision resolving false, counters unchanged, signer refusing.
7. Run the verifier over the trace, including the bounce.

The per-call cap is set deliberately **above** the malicious vendor's ask, and both vendors are
allowlisted, so the bounce comes from the encrypted budget rather than a public `require()`.
Otherwise it would prove nothing about Inco.

Have the answer ready for *"the computation is off-chain, so what did Inco actually prove?"*:
Inco proves the decision; the chain proves the decision was committed before it was knowable; the
signer is bounded to decisions already on the chain.

## Hackathon-v1 simplifications

Stated plainly rather than glossed:

- Only `remainingBudget` is encrypted (`euint256`). `perCallCap` and `callsRemaining` are public.
- The Authorization Signer is a trusted **[ASSUMPTION]** — Inco provides no key custody. Compromising
  it permits re-signing spends the chain already approved, not inventing new ones.
- Encrypted allowlists, escrow-based x402 schemes, refund-on-timeout accounting, and multi-goal
  concurrency are out of scope.
- The LLM agent falls back to a deterministic scripted stand-in when `LLM_API_KEY` is unset. The
  scripted agent complies with the injection too, and the UI labels which one ran.
