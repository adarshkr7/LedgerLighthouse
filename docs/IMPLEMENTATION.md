# Implementation Brief — Inco-Bound Agent Payment Flow

**Companion to:** `inco-agent-payment-plan.md` — the plan, architectural source of truth
**Audience:** Claude Code, or any engineer picking this up cold
**Target:** Base Sepolia + Inco Lightning + x402 + EIP-3009 + TypeScript orchestrator + dumb
Authorization Signer + verifiable trace, driven from **MetaMask**

---

## 0. How to use this document

Read v3 first. This document does not restate the architecture; it turns it into an ordered,
testable build with explicit stop points.

**The rule that governs everything below:** do not implement the whole project in one pass. Work
one milestone at a time, run that milestone's acceptance tests, and stop. Each milestone is sized so
that a failure is diagnosable in minutes rather than hours.

**Before writing any code, complete Phase 0 (repository inspection) and report back.** Do not begin
M1 until the inspection report has been reviewed.

---

## 1. Non-negotiables

These are invariants, not preferences. If a proposed change violates one, stop and raise it.

1. **The orchestrator is untrusted.** It never holds the payer key, never evaluates or modifies policy, and is never granted access to a budget handle. It may *point* the signer at an already-finalized `(goalId, seq)` — that is a pointer, not an instruction, and the distinction is the whole design. It never supplies terms, amounts or addresses to the signer.
2. **The Authorization Signer stays.** Inco provides no key custody or signing. Do not remove it, do not merge it into the orchestrator, and do not add terms fields to its request schema. Not "validate and ignore them" — they must not be in the schema at all.
3. **The signer reads the chain, never the caller.** Its only input is `(goalId, seq)`. Every EIP-3009 field is read from the finalized on-chain record.
4. **No generic TEE substitution.** If Inco is hard at some point, the answer is to ask, not to swap in a mock enclave and keep the vocabulary.
5. **Do not invent Inco APIs.** Anything not verified in the current docs or already present in the repo gets marked `[OPEN — VERIFY WITH INCO DOCS]` and verified before use. Same rule for x402 payload shapes.
6. **Encrypted state is never revealed.** Only the per-request decision `ebool` is ever passed to `e.reveal`. Reveals are permanent.

---

## 2. Phase 0 — Repository inspection (do this first)

Inspect and report. Make no changes.

### 2.1 Current stack
Languages · frameworks · package manager (npm/pnpm/bun) · Solidity pragma and Foundry version
(`foundry.toml`, `forge --version`) · Node and TypeScript versions · existing frontend · existing
blockchain libraries (viem/ethers/wagmi) · existing Inco or x402 dependencies.

### 2.2 Existing contracts
Names · responsibilities · deployment config and scripts · any existing payment or policy logic ·
whether `remappings.txt` already maps `@inco/`.

### 2.3 Existing agent / payment code
Orchestrator · LLM integration and provider · x402 client · 402 parsing · payment flow · retry
logic · any signer.

### 2.4 Existing Inco integration
Installed packages (`@inco/lightning`, `@inco/lightning-js`, or the older `@inco/js`) · encrypted
types in use · contract integration · Inco config and network selection · existing cheatcode tests ·
**anything inconsistent with v3.**

Two details worth confirming rather than assuming: the Solidity library ships as an npm package but is
consumed through Foundry remappings, and `@inco/` must remap to the `@inco` directory itself, not to
`@inco/lightning`. The current import path is `@inco/lightning/src/Lib.sol`; older samples show
`@inco/lightning/Lib.sol`.

### 2.5 Existing tests
Unit · integration · contract · security/invariant · coverage and obvious gaps.

### 2.6 Current stage
Map the repo onto v3's stages: Stage 1 (goal/policy), Stage 2 (x402 control flow), Stage 3
(authorization/settlement), Stage 3→Inco migration, Stage 4 (trace/attestation), or a mixture.

### 2.7 MetaMask-specific inspection
Existing wallet connection · chain config (is Base Sepolia 84532 present?) · whether any flow
currently expects a browser signer where the v3 design needs a server key, or vice versa.

### 2.8 Report format

Produce, and then **stop**:

- Repository assessment (concise).
- Mapping table: existing file → v3 component → status (`aligned` / `needs change` / `conflicts` / `missing`).
- Architectural or security problems found, with the invariant each one threatens.
- `[OPEN — VERIFY WITH INCO DOCS]` register — every unverified API you would otherwise need.
- **The single smallest next step**, the exact files it touches, and the tests that should pass after it.

Then wait for confirmation.

---

## 3. Target repository layout

Adapt to what exists rather than forcing this shape. Presented so the pieces have names.

```
contracts/              Foundry — PolicyVault, TraceAnchor, deploy scripts, tests
packages/shared/        TS types shared across services: terms schema, termsHash, ABIs
services/orchestrator/  Untrusted. LLM + x402 client. Holds NO keys.
services/signer/        Trusted [ASSUMPTION]. Holds the per-goal payer key. Reads chain only.
services/trace/         Hash chain, Merkle accumulator, standalone verifier CLI
apps/web/               MetaMask UI: open goal, fund, watch, verify
mock-api/               x402-priced endpoint with an honest and a malicious mode
```

**Enforce the key boundary at the dependency level.** `services/orchestrator` must not depend on any
signing library, and must not import from `services/signer`. Make that a lint rule or a package
boundary, not a comment — it is the security property that the whole demo rests on, and it is the
one an LLM writing code will erode first.

---

## 4. Stack decisions

| Layer | Choice | Notes |
|---|---|---|
| Chain | Base Sepolia (chainId **84532**) | Inco Lightning is live here |
| Contracts | Solidity + Foundry | Start from Inco's `lightning-rod` template for correct remappings and cheatcodes |
| Confidential | `@inco/lightning` (Solidity), `@inco/lightning-js` (TS) | Package was renamed from `@inco/js` — older doc samples still show the old name |
| Chain client | **viem** everywhere | Inco's own examples use viem; mixing in ethers creates avoidable friction |
| Wallet | **wagmi + viem**, MetaMask connector | RainbowKit only if you want the connector list; not required for one wallet |
| Backend | TypeScript + Node 22 LTS | Node 20 left maintenance in April 2026 — do not start a new project on it. Fastify or Express, whichever is already present |
| LLM | Whatever provider the repo already uses | Do not introduce a second one |
| Frontend | Preserve what exists; otherwise Vite + React + TS | Next.js only if the repo already has it |
| Tests | Foundry (Solidity) + Vitest (TS) | Inco cheatcodes for the encrypted path |

---

## 5. MetaMask integration design

This is the part most likely to be built wrong, because the instinct is to route every signature
through the wallet. Two of the three signing needs must **not** go through MetaMask.

### 5.1 The three keys, and who holds each

| Key | Holder | Signs |
|---|---|---|
| **User key** | MetaMask | `openGoal`, the USDC funding transfer, goal closure |
| **Payer key** | Authorization Signer, per goal, ephemeral | EIP-3009 `transferWithAuthorization` |
| **Relay key** | Orchestrator | `requestSpend` and `finalize` gas only — **holds no funds, authorizes no payment** |

**Why the payer key is not MetaMask.** The agent must pay autonomously while the user is away. A
wallet prompt per payment defeats the product. The ephemeral key exists so the agent can act without
the user, and the Inco policy exists so acting-without-the-user is bounded.

### 5.2 The MetaMask flow, start to finish

1. **Connect** — wagmi MetaMask connector, `switchChain` to 84532, offer `wallet_addEthereumChain` if absent.
2. **Mint the payer address** — the signer generates the per-goal ephemeral key and returns *only* its address. No wallet interaction. **This must happen before `openGoal`**, because the payer address is a field of the goal record.
3. **Encrypt the budget client-side** — `@inco/lightning-js` encrypts `remainingBudget`, `perCallCap`, `callsRemaining` in the browser, bound to the connected address. `[OPEN — VERIFY WITH INCO DOCS]`: exact encryption method name and signature.
4. **Open the goal** — MetaMask sends `openGoal` with the three ciphertexts *and the payer address from step 2*. **This transaction must come from the user's own address**, because on-chain ciphertext conversion binds to `msg.sender`. The orchestrator structurally cannot open a goal.
5. **Fund the ephemeral payer** — the user sends USDC to that address from MetaMask.
6. **Hand off** — the orchestrator runs unattended. No further wallet prompts.
7. **Verify** — the UI reads the budget handle (renders as opaque `bytes32`), the decision per request, and the trace.

Steps 2 and 4 are ordered, not interchangeable. If the key is generated after the goal is open you need
either a second registration transaction or a mutable payer field — and a mutable payer field lets
whoever can write it redirect every future signature.

### 5.3 The funding step is a second, independent spending bound

Worth building deliberately and worth saying on stage: the ephemeral account holds only what
MetaMask sent it. Even in the hypothetical where the Inco policy were bypassed entirely, the loss
ceiling is the funded amount. Fund it with slightly *more* than the encrypted budget so the demo
shows the Inco policy binding first — if they are equal, a judge cannot tell which control stopped
the payment.

### 5.4 What does *not* need MetaMask

Retrieving the decision. The vault calls `e.reveal` on the decision `ebool`, which makes it publicly
accessible — anyone may then request an attested decryption, with **no EIP-712 wallet signature
required**. This is the reason v3 chose reveal over `attestedDecrypt`: the payment loop must run
unattended, and `attestedDecrypt` requires a signature from an address with access.

If you ever find yourself needing a MetaMask prompt inside the payment loop, the design has drifted.

### 5.5 MetaMask gotchas to handle explicitly

- Chain switch rejected → block the UI on it; do not silently write to the wrong chain.
- Account switched mid-session → invalidate the goal context; ciphertexts are bound to the address that produced them.
- Base Sepolia ETH for gas and test USDC are separate faucet trips. Document both in the README.
- MetaMask sometimes caches a stale `chainId` after a manual network change — re-read it on every write rather than trusting connection-time state.

---

## 6. Milestones

Each milestone: goal, files, acceptance tests, stop point. **Report and stop after every one.**

### M0 — Skeleton and inspection follow-up
Resolve Phase 0 findings. Establish workspace layout, remappings, the orchestrator↛signer dependency
boundary, and `.env.example`. No behaviour.
**Passes when:** `forge build` and `tsc --noEmit` are clean; the boundary rule fails CI if the
orchestrator imports the signer.

### M1 — x402 control flow against a mock (v3 Stage 2)
Mock API returning 402 with payment requirements, plus a strict parser and the 200/402/5xx branch.
No money, no Inco, no signing.
**Files:** `mock-api/`, `services/orchestrator/src/x402/`, `packages/shared/src/terms.ts`
**Passes when:** 200 returns data; 402 produces typed terms; malformed 402 is rejected rather than
coerced; 5xx retries with backoff; the response cache prevents a re-entry into the payment path.
**Pin the protocol version before writing the parser.** x402 v1: request header `X-PAYMENT`, response
header `X-PAYMENT-RESPONSE`, body `{ x402Version, accepts: [...] }` where each entry carries `scheme`,
`network`, `asset`, **`maxAmountRequired`** (not `amount`), `payTo`, `resource`, `description`,
`maxTimeoutSeconds`, `extra`. The v2 spec renames the headers to `PAYMENT-REQUIRED` /
`PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` and encodes `network` as CAIP-2 (`eip155:84532`). Pick one,
record the choice in the README, and make the mock speak only that version. `[OPEN]`: which version the
facilitator you actually use expects.

### M2 — Payment path with a plaintext budget (v3 Stage 3, pre-Inco)
`PolicyVault` with a **plain `uint256`** budget. Real EIP-3009, real facilitator, real USDC on Base
Sepolia. Signer service reading approvals from the chain.
**Files:** `contracts/src/PolicyVault.sol`, `services/signer/`, `services/orchestrator/src/pay/`
**Passes when:** an end-to-end paid request succeeds on Base Sepolia; the signer refuses an unapproved
`(goalId, seq)`; a request to the signer carrying any terms field is **rejected by schema validation**
rather than accepted-and-ignored; the signer asserts the USDC address and chain id before signing;
**an interrupted settlement retried with the identical authorization tuple does not double-pay.**

> **The retry test is the one that matters.** Freeze `validAfter` / `validBefore` into the on-chain
> record at `requestSpend` time. If the signer regenerates the validity window from the clock, the
> retry is a *different* authorization and the token contract will happily execute it twice. Write
> this test before you need it.

### M3 — Migrate the budget into Inco (v3 Stage 3 → Inco)
Swap counters to `euint256`. Encrypted conjunction, `e.select` debit, `allowThis` on persisted
handles only, `e.reveal` on the decision, attested reveal, `finalize` with signature **and** handle-match
verification.
**Files:** `PolicyVault.sol`, `services/orchestrator/src/inco/`, contract tests
**Passes when:** an in-policy spend approves and settles; an over-cap spend rejects with counters
unchanged; the budget handle reads as opaque `bytes32` on Basescan; `finalize` rejects a valid
attestation for the *wrong* handle; **the orchestrator is never granted access to a budget handle.**

State that last one precisely. The orchestrator *may* request an attestation for the revealed decision
handle — `e.reveal` makes it public and anyone can — and that is expected, convenient and harmless,
since it cannot forge one. "No handle access at all" is the wrong test and will send you chasing a
failure that is actually correct behaviour. The property is: no access to `remainingBudget`,
`perCallCap` or `callsRemaining`, ever, including for debugging.

Verify before coding: `[OPEN — VERIFY WITH INCO DOCS]` the browser encryption call, cheatcode names,
`inco.getFee()` scope, and **how to know when a revealed handle is ready** — the compute server
processes emitted events asynchronously, so `finalize` needs a bounded polling or retry strategy
rather than an immediate call. The retrieval call itself is settled: `zap.attestedReveal([handle])`,
no wallet signature. What is open is the *timing*, not the API.

### M4 — The malicious-402 demo (the centrepiece)
Malicious mode on the mock API: inflated price plus an injection claiming pre-approval. Surface the
orchestrator's reasoning in the UI.
**Passes when:** the reasoning trace visibly **complies** with the injection; `requestSpend` still
lands; the decision resolves false; counters are unchanged; the signer refuses; the bounce appears
in the trace with its handle and signatures.

Do not soften step one. The demo's whole force comes from the model being genuinely fooled and the
money still not moving.

### M5 — Trace and anchoring (v3 Stage 4)
Hash chain, Merkle accumulator, `TraceAnchor` contract, standalone verifier CLI.
**Passes when:** the verifier validates a good trace, rejects a tampered step, rejects a swapped
attestation, and runs with no dependency on your services beyond a public RPC.

### M6 — Demo UI polish
Goal opening, funding, live decisions, trace viewer, honest/malicious toggle.
**Passes when:** the full demo runs from a cold MetaMask in under five minutes.

---

## 7. `[OPEN — VERIFY WITH INCO DOCS]` register

Carry this list forward; check items off with a doc link before writing code against them.

| # | Item | Needed by |
|---|---|---|
| 1 | Client-side encryption method name/signature in `@inco/lightning-js` for producing `euint256` input ciphertexts | M3 |
| 2 | ~~Exact `attestedReveal` return shape and whether a wallet client is required~~ — **answered.** `zap.attestedReveal([...handles])` returns plaintexts plus covalidator signatures for on-chain re-submission; no wallet signature, because `e.reveal` already made the handle public | — |
| 3 | **Readiness signal** — how a caller knows a revealed handle is decryptable yet; polling vs. event | M3 |
| 4 | `inco.getFee()` scope — which operations charge, and whether `requestSpend` must be payable | M3 |
| 5 | Inco cheatcode names and setup for Foundry tests | M3 |
| 6 | Base Sepolia Lightning config / contract addresses used by the SDK | M3 |
| 7 | `e.transientAllow` availability (documented as not yet in the SDK) | M3 |
| 8 | Compute-server lag under two rapid successive spends — behaviour is undocumented | M3 |
| 9 | ~~Base Sepolia USDC address and EIP-3009 domain/version~~ — **answered.** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals, `FiatTokenV2_2`, domain `name: "USDC"`, `version: "2"`, `chainId: 84532` | — |
| 10 | Facilitator endpoint, and which x402 version it speaks (body schema and header names are known — see M1) | M1/M2 |

Items 3 and 8 are the ones most likely to cost a day. Test both on Base Sepolia during M3 before
building anything that assumes tight timing. Numbering is stable — struck-through rows keep their
numbers so that references elsewhere in this document do not silently shift.

---

## 8. Guardrails

Anti-patterns that will silently break the security story:

- Letting the signer accept an `amount` or `payTo` parameter "for convenience."
- Granting the orchestrator handle access to debug a failing check.
- Calling `e.allowThis` on intermediate results — unnecessary, and a habit that leads to granting on the wrong handle.
- Calling `e.reveal` on a budget handle to make a test pass. Reveals are permanent.
- Replacing the async reveal wait with a hardcoded `sleep`. Poll with a bounded timeout and surface the timeout.
- Regenerating the EIP-3009 validity window on retry.
- Prompting MetaMask inside the payment loop.
- Catching a policy rejection and retrying with a smaller amount automatically. The bounce is the product; make it visible instead.
- Letting the signer read `asset` or the token address from anywhere but the goal record. A 402 body is a claim, not a source of configuration.
- Making the goal's payer address mutable after `openGoal`.
- Computing `remaining - amount` before the `e.select`. Select the operand instead — see v3 §7.3.

---

## 9. Configuration

`.env.example` should be committed with every key present and no real values:

```
CHAIN_ID=84532                # assert this before every write; never infer it from the wallet
BASE_SEPOLIA_RPC_URL=
POLICY_VAULT_ADDRESS=
TRACE_ANCHOR_ADDRESS=
INCO_NETWORK=                 # Lightning network selector used by the SDK — item 6
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
X402_VERSION=                 # 1 or 2 — decides header names; see M1
X402_FACILITATOR_URL=         # verify — item 10
SIGNER_KEY_STORE_PATH=        # never a key inline; file or KMS reference
ORCHESTRATOR_RELAY_KEY=       # gas only
LLM_API_KEY=                  # use the provider already in the repo
```

`USDC_ADDRESS` is checked in with a real value deliberately — it is a public testnet address, and a
blank makes it too easy to point the signer at whatever a 402 body claims. The signer should assert it
and `CHAIN_ID` against the goal record before every signature.

**Never** put the payer key in the orchestrator's environment, even temporarily. Never log a
ciphertext handle alongside its plaintext.

---

## 10. Demo runbook

1. Connect MetaMask, switch to Base Sepolia.
2. Open a goal — budget and per-call cap encrypted in the browser. Show the resulting handle on Basescan: an opaque `bytes32`.
3. Fund the ephemeral payer with test USDC, slightly above the encrypted budget.
4. **Run 1, honest 402** — request, price, approve, settle, data returns.
5. **Run 2, malicious 402** — inflated price plus injection. Show the model complying. Show the commit transaction landing. Show the decision resolving false, counters unchanged, signer refusing.
6. Run the standalone verifier over the trace, including the bounce.

Have the answer ready for *"the computation is off-chain, so what did Inco actually prove?"*:
Inco proves the decision; the chain proves the decision was committed before it was knowable; the
signer is bounded to decisions already on the chain. Knowing which component provides which
guarantee is worth more than an extra feature.

---

## 11. First action

Run Phase 0. Produce the inspection report in the §2.8 format. Recommend the single smallest next
step. **Then stop and wait for confirmation.**
