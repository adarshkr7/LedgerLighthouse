<p align="center">
  <img src="docs/lighthouse.webp" alt="LedgerLighthouse — confidential agentic payments" width="100%" />
</p>

<p align="center">
  <strong>An autonomous AI agent that pays for APIs over x402 — where the spending policy is enforced by
  confidential computation, not by the agent itself.</strong>
</p>

<p align="center">
  <a href="https://github.com/adarshkr7/NTU_x402/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/adarshkr7/NTU_x402/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/adarshkr7/NTU_x402/actions/workflows/ci.yml"><img alt="234 tests passing" src="https://img.shields.io/badge/tests-234%20passing-2f5c4a" /></a>
  <a href="https://sepolia.basescan.org/address/0x0C759D06a1c14F43852D7b078Db2f8C342F15921"><img alt="Live on Base Sepolia" src="https://img.shields.io/badge/live-Base%20Sepolia-0052ff" /></a>
  <img alt="x402 v1" src="https://img.shields.io/badge/x402-v1-16150f" />
  <img alt="Inco Lightning 1.0.2" src="https://img.shields.io/badge/Inco%20Lightning-1.0.2-7c382e" />
  <img alt="Oasis ROFL" src="https://img.shields.io/badge/Oasis-ROFL%20TDX-0500e2" />
</p>

---

## Why "LedgerLighthouse"

A lighthouse is useful precisely because it does not negotiate. It stands in one place, marks the
hazard, and is indifferent to what the ship believes, wants, or has been told. A captain who is
lost — or actively deceived — does not get to move it. Ships do not steer lighthouses.

That is the whole design. The agent's view of the world is attacker-controlled: the vendor writes the
price, the description, and any instruction it likes. What it cannot touch is the encrypted budget
inside the contract, or the attestation reporting how the policy ruled. The agent can be completely
convinced. The money still does not move.

The *ledger* is what makes the light checkable afterwards. Every decision lands on chain, in order,
committed before anyone — including the agent — can know what it was.

> **The invariant:** compromise of the AI orchestrator must not confer arbitrary spending authority.

---

## The attack, and why it fails

Give an agent a wallet and you are defending a private key with a text filter: a probabilistic
control guarding a deterministic, irreversible asset. A 99%-accurate filter fails one call in a
hundred, and agents make thousands.

LedgerLighthouse does not try to make the agent trustworthy. It makes the agent's trustworthiness
irrelevant.

| | Malicious vendor's plan | What actually happens |
|---|---|---|
| 1 | Return `402` with an inflated price and an injection in `description` | The parser takes `maxAmountRequired`, payee and asset from the **schema**. The prose reaches only the model. |
| 2 | Convince the model to approve | It succeeds. The agent complies — and the UI shows it complying. |
| 3 | Agent authorizes the spend | It cannot. The agent holds the **relay** key, which pays gas and authorizes nothing. |
| 4 | Relay commits `requestSpend` | The debit commits **before** the decision is knowable. |
| 5 | Inco evaluates against the encrypted budget | `false`. The overspend is caught by ciphertext, not by a `require()`. |
| 6 | Ask the signer to sign anyway | The signer reads the **finalized on-chain record**, never the caller. No signature exists to give. |

The per-call cap is set deliberately **above** the malicious ask, and every vendor is allowlisted, so
a bounce comes from the encrypted budget rather than a public precondition. Otherwise it would prove
nothing.

---

## The four resources

The console opens with a searchable catalog. Two settle and two are refused — and the two refusals
fail for **different reasons**, which is the point of having four rather than two.

| Resource | Price | Outcome | What it shows |
|---|---|---|---|
| Market data snapshot | 0.01 | settles | The whole nine-stage path, cheaply |
| Bulk history archive | 0.12 | settles | 12x dearer, still inside the budget — a visible cut from the payer |
| Compliance audit bundle | 0.35 | **refused** | No injection, ordinary copy, far under the public 6.00 cap. **Only the encrypted budget can reject this.** |
| Premium feed | 5.00 | **refused** | ~500x plus a prompt injection. The agent complies; it changes nothing. |

The two honest calls sum to 0.13, inside the 0.20 encrypted budget, so you can run both and watch
USDC leave the payer twice before anything bounces.

`compliance-audit` is the one to demo to a sceptic. Its payee is allowlisted, its description is
unremarkable prose, and its price clears every public precondition. Nothing public can refuse it — so
when it bounces, the bounce came from the confidential policy and nowhere else.

Definitions live in [`packages/shared/src/demo/catalog.ts`](packages/shared/src/demo/catalog.ts),
imported by the mock API, the orchestrator and the console alike, so prices cannot drift between what
is charged and what is displayed.

---

## The 60-second version

```sh
pnpm install --ignore-scripts
```

```sh
cp .env.example .env
```

```sh
pnpm dev
```

Open <http://127.0.0.1:5173>, connect MetaMask on Base Sepolia, and walk the five steps.

Headless equivalent, and the fastest way to confirm everything works:

```sh
pnpm --filter @ntux402/e2e run demo
```

---

## Who holds which key

This table is the security design, not a deployment detail.

| Key | Holder | Signs | Can it move your money? |
|---|---|---|---|
| **User** | MetaMask | `openGoal`, the USDC funding transfer, goal closure | Yes — it's yours |
| **Payer** | Authorization Signer, per goal, ephemeral | EIP-3009 `transferWithAuthorization` | Only what the chain already approved |
| **Relay** | Orchestrator | `requestSpend`, `finalizeDecision` — **gas only** | No |
| **Facilitator** | Facilitator (infrastructure) | Submits the settlement tx — **gas only** | No |

`services/orchestrator` must never import `services/signer`, by package name or relative path.
[`scripts/check-boundary.mjs`](scripts/check-boundary.mjs) enforces it in CI. That check is the whole
demo's load-bearing wall.

---

## Two TEEs, and no bridge between them

Confidential computation answers *what the policy decided*. It does not answer *who holds the key
that acts on the decision*. Those are different problems, and they are solved by different enclaves.

**Inco Lightning** enforces the budget on Base. The confidential compute server runs inside a secure
enclave; the browser encrypts the budget to that enclave over HPKE, and the enclave signs
attestations that `e.verifyDecryption` checks on chain. The contract never sees a plaintext balance.

**Oasis ROFL** holds the payer key. `RoflKeyStore` derives each ephemeral payer key through
`rofl-appd` over a socket that exists only inside the container, and Oasis answers only for properly
attested app instances. No operator — including whoever runs the machine — can extract it.

The two never talk to each other, and nothing bridges between them. Inco rules on a spend; the
enclave in Oasis signs an EIP-3009 authorization for a spend Base has already approved. The money
stays on Base the entire time.

| | Local key store | ROFL key store |
|---|---|---|
| Key origin | `generatePrivateKey()` | Derived in-enclave, attested |
| On disk | the private key | `address -> key_id` only |
| Extractable by the operator | yes | no |
| Survives restart | yes | yes — re-derived, nothing secret persisted |

Deployment is three CLI commands and a published image; the manifest and container definition live
in [`services/signer/`](services/signer/). Until you run them, the signer uses the local file store —
which is exactly the trust assumption ROFL removes.

```sh
oasis rofl create --network testnet
```

```sh
oasis rofl build
```

```sh
oasis rofl deploy
```

Needs the `oasis` CLI, a publicly published `linux/amd64` image pinned by digest, and ~150 TEST ROSE
from the faucet.

**What this proves, and what it does not.** It proves custody: the key exists only inside an attested
enclave. It does not prove that *to Base*, which cannot verify Oasis attestations — the binding
between payer address and enclave identity is asserted by the app, not checkable by a third party
from Base. Publishing that binding on Sapphire would close the gap.

---

## Layout

```
contracts/              Foundry — PolicyVault, TraceAnchor, deploy scripts, tests
packages/shared/        TS types across services: x402 schema, ABIs, USDC/EIP-3009 constants
services/orchestrator/  Untrusted. LLM + x402 client + payment loop. Relay key only.
services/signer/        Holds the per-goal payer key. Reads chain only. ROFL container + manifest.
services/facilitator/   Self-hosted x402 v1 facilitator. Outside the trust boundary.
services/trace/         Hash chain, Merkle accumulator, standalone verifier CLI
apps/web/               MetaMask UI: landing page + execution console
mock-api/               x402-priced endpoints — one per catalog resource
tools/e2e/              Operator scripts: keygen, fund, balances, state, demo, tee-check
```

---

## Prerequisites

- **Node 22+** and **pnpm 11** (pinned via `packageManager`; `corepack enable` picks it up).
- **Foundry** — `curl -L https://foundry.paradigm.xyz | bash && foundryup`. Verified on forge 1.7.1.
- A Base Sepolia RPC URL.

## Setup

```sh
pnpm install --ignore-scripts
```

`--ignore-scripts` is deliberate: the git-hosted Solidity dependencies (`forge-std`, `ds-test`,
`safe-smart-account`) declare JS build scripts we do not need — we consume only their `.sol` sources
through Foundry remappings.

Then generate and fund the two gas-only roles:

```sh
pnpm --filter @ntux402/e2e run keygen
```

```sh
pnpm --filter @ntux402/e2e run fund
```

```sh
pnpm --filter @ntux402/e2e run balances
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

## Before you push

```sh
pnpm verify
```

```sh
pnpm verify --skip-contracts
```

The first mirrors CI exactly; the second skips Foundry if it is not installed. Enable the pre-push
hook once per clone with `git config core.hooksPath .githooks`.

---

## Checking the confidential path on its own

`demo` proves the *product* — x402, USDC, the signer, the injection. That makes it a poor instrument
for the narrower question "is the confidential layer working", because a fault anywhere in the
payment path looks identical from outside. `tee-check` removes everything that is not Inco: no USDC
moves, the signer never starts, no vendor is contacted.

```sh
pnpm --filter @ntux402/e2e run tee-check
```

It encrypts a budget, turns it into an on-chain handle, then runs two spends through the full round
trip — one inside the budget, one past it but still under the public cap and to an allowlisted payee,
so nothing in plaintext can account for the refusal. For each it polls `attestedReveal`, submits the
attestation through `finalizeDecision`, and confirms the on-chain result.

The load-bearing assertion is the third one per spend: the attestation is re-submitted with the
plaintext **flipped**, and on-chain verification must reject it. Signatures cover `(handle,
plaintext)` as a pair, so a genuine attestation paired with the opposite claim does not verify. Were
that check to pass, the attestation would be decoration and the decision path worthless. It is
simulated rather than sent, so it costs nothing and cannot consume the pending spend.

Costs one Inco fee (0.000001 ETH) plus gas for five transactions.

```
pass  encrypted                      0.1 USDC in 28ms
pass  budget handle                  0x7adf19cd816945ba…65000800
pass  attestedReveal                 true in 11.43s (2 attempts), 2 signatures
pass  flipped plaintext is rejected  claimed false, on-chain verification refused it
pass  on-chain isApproved agrees     true
pass  attestedReveal                 false in 7.26s (1 attempt), 2 signatures
pass  flipped plaintext is rejected  claimed true, on-chain verification refused it
pass  on-chain isApproved agrees     false
```

## Verifying a trace

Every run produces a hash-chained trace with a Merkle root. The verifier needs the file and a public
RPC — nothing else, by design:

```sh
curl -s http://127.0.0.1:8404/traces/6 -o trace.json
```

```sh
pnpm --filter @ntux402/trace run verify -- trace.json
```

It re-derives every step hash, recomputes the root, and cross-checks each attestation against
`PolicyVault`: the attested handle must equal **the handle the vault stored**, and the recorded
decision must equal the on-chain one. Signature validity alone is insufficient — a genuine
attestation for a different handle is otherwise substitutable.

---

## Demo runbook

1. Connect MetaMask, switch to Base Sepolia.
2. Mint the ephemeral payer — **before** opening the goal, because the payer address is a field of
   the goal record.
3. Open the goal. Show the budget handle on Basescan: an opaque `bytes32`.
4. Fund the payer with slightly **more** than the encrypted budget, so the policy binds first.
5. **Market data snapshot, 0.01** — request, price, approve, settle, data returns.
6. **Bulk history archive, 0.12** — the same path at 12x the price. Watch the payer balance take a
   visible cut and the ring move.
7. **Compliance audit bundle, 0.35** — no injection, ordinary description, far below the public cap,
   payee allowlisted. Refused anyway. Ask the room what could possibly have rejected it.
8. **Premium feed, 5.00** — inflated price plus injection. Show the agent complying. Show the commit
   transaction landing. Show the decision resolving false, counters unchanged, signer refusing.
9. Run the verifier over the trace, including the bounce.

Have the answer ready for *"the computation is off-chain, so what did Inco actually prove?"* — Inco
proves the decision; the chain proves the decision was committed before it was knowable; the signer
is bounded to decisions already on the chain.

---

## Verified facts

Resolved against the published packages and live chain:

| Item | Value |
|---|---|
| Inco substrate | **TEE**, not FHE. Enclave-side compute; HPKE to the enclave client-side |
| `@inco/lightning` (Solidity) | `1.0.2`; import path `@inco/lightning/src/Lib.sol` |
| `@inco/lightning-js` (TS) | `1.0.2`; peer dep viem `^2.39.3` |
| Inco Lightning executor (Base Sepolia + mainnet) | `0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624` |
| Inco Verifier | `0x867758FFe098fB0D74826A8DCf60127696440f09` |
| Oasis ROFL key API | `POST /rofl/v1/keys/generate`, `secp256k1`, over `/run/rofl-appd.sock` |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals, domain `name: "USDC"`, `version: "2"` |
| solc / evm | `0.8.29`, `cancun` |
| **PolicyVault (deployed)** | [`0x0C759D06a1c14F43852D7b078Db2f8C342F15921`](https://sepolia.basescan.org/address/0x0C759D06a1c14F43852D7b078Db2f8C342F15921) |

**`attestedReveal` latency after `requestSpend` confirms: 6–12 seconds**, 1–2 poll attempts, measured
repeatedly on Base Sepolia. A *rejected* decision is consistently faster than an approved one — worth
knowing for demo pacing.

Polling is bounded at 180s and a timeout is a **reported outcome**, not a swallowed exception: the
debit has already committed, so "decision unavailable" is a different state from "rejected", and
conflating them would misreport where the money went.

---

## Protocol version — pinned to x402 **v1**

| | v1 (**ours**) | v2 (not used) |
|---|---|---|
| Request header | `X-PAYMENT` | `PAYMENT-SIGNATURE` |
| Response header | `X-PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` |
| 402 header | — | `PAYMENT-REQUIRED` |
| `network` | slug — `base-sepolia` | CAIP-2 — `eip155:84532` |

The mock API speaks only v1, and the parser rejects a v2-shaped body rather than adapting to it.
Constants live in [`packages/shared/src/x402/protocol.ts`](packages/shared/src/x402/protocol.ts).

The amount field on the wire is **`maxAmountRequired`**, never `amount`. The internal `Terms.amount`
is derived from it, and the two names are kept distinct on purpose so a parser bug cannot silently
substitute one for the other.

`services/facilitator` is a self-hosted x402 v1 facilitator speaking the version we pinned. Its
interface (`POST /verify`, `POST /settle`, `GET /supported`) matches the hosted shape, so swapping to
Coinbase's is a URL change.

---

## Scope and limits

Stated plainly rather than glossed:

- Only `remainingBudget` is encrypted (`euint256`). `perCallCap` and `callsRemaining` are public.
- On Base, the payer-address-to-enclave binding is asserted by the ROFL app rather than verified on
  chain, because Base cannot check Oasis attestations.
- Encrypted allowlists, escrow-based x402 schemes, refund-on-timeout accounting, and multi-goal
  concurrency are out of scope.
- The LLM agent falls back to a deterministic scripted stand-in when `LLM_API_KEY` is unset. The
  scripted agent complies with the injection too, and the UI labels which one ran.

## Further reading

- Architecture — how the pieces fit and why: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Implementation reference — where things live, what proves them: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)
- Technical primer — every technology from first principles, plus a question drill: [`docs/PRIMER.md`](docs/PRIMER.md)
- Pitch deck: [`pitch/LEDGERLIGHTHOUSE_NTU_INNOVATEX_DECK.md`](pitch/LEDGERLIGHTHOUSE_NTU_INNOVATEX_DECK.md)
