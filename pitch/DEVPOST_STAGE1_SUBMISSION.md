# Devpost Stage 1 — Submission Pack

**Deadline: 14 August 2026, 11:59 PM SGT** · today is 12 August 2026 → **2 days**
Screening 15–16 Aug · shortlist notified ~16 Aug

Each section below is paste-ready into the matching Devpost field.
Blockers are at the end — **one of them will sink the repo link if not fixed.**

---

## 1. Project Details *(mandatory)*

**Project title**
```
LedgerLighthouse — The Spending Bound an Agent Cannot Move
```

**Track**
```
Track 2 — Web3 Applications, AI Agents and Real-World Use Cases
```

**Team type**
```
Student Group — IIT Patna & IIT Bombay
```
*(Requires proof of current student status for **every** member — see Blocker 2.)*

**Short description** *(tagline, ~200 chars)*
```
An AI agent that buys paywalled APIs over x402, where the spending limit is an encrypted number
on-chain. Jailbreak the agent completely and it still cannot move money. Live on Base Sepolia.
```

---

## 2. Project Overview *(mandatory)*

### The problem

Autonomous agents increasingly need to buy things — paywalled APIs, data feeds, compute. The x402
standard makes this trivial to wire up: an agent pays for an HTTP resource with a single header.

That convenience creates a structural vulnerability. To let an agent pay, you give it spending
authority. But the x402 `description` field is **vendor-controlled free text that lands directly in
the model's context window**. A malicious vendor can embed instructions claiming pre-approval,
urgency, or administrative authority.

The industry's answer is to make the model behave — guardrails, system prompts, injection
classifiers. All of these are **probabilistic controls defending a deterministic, irreversible
asset**. A filter that is 99% accurate fails one call in a hundred; an agent makes thousands. The
defender must win every time, the attacker needs one success. The asymmetry is structural, not an
implementation bug.

### Our solution

A lighthouse is useful precisely because ships cannot move it. LedgerLighthouse stops trying to make
the agent trustworthy and instead makes its trustworthiness **irrelevant to the payment decision**.
One invariant:

> **Compromise of the AI orchestrator must not confer arbitrary spending authority.**

The remaining budget lives on Base Sepolia as an encrypted `euint256` — an opaque handle, never a
plaintext number. The spending decision is computed inside a **trusted execution environment** by a
smart contract the agent cannot read, influence, or bypass. A fully jailbroken orchestrator retains
exactly one capability: proposing a spend that gets rejected.

### Key features

- **Confidential budget enforcement (Inco Lightning, TEE-backed).** `PolicyVault.sol` compares
  `amount ≤ budget` over encrypted handles, then applies a write-ahead debit via `e.select` —
  resolving to the amount if affordable, to zero if not. **You cannot branch on an encrypted
  condition**, so the debit *must* be unconditional — which means it commits *before anyone,
  including the agent, can learn the decision*. The platform enforces the write-ahead ordering we
  would otherwise have to argue for.
- **Two enclaves, no bridge between them.** Inco decides *what the policy ruled*, on Base. **Oasis
  ROFL** holds *the key that acts on it*: the ephemeral payer key is derived inside an Intel TDX
  enclave via `rofl-appd`, and Oasis serves keys only to attested instances — no operator, including
  whoever runs the machine, can extract it. The two never communicate, so no message relay sits
  inside the trust boundary and the money never leaves Base.
- **A deliberately "dumb" authorization signer.** It accepts only `(goalId, seq)` — two integers, a
  pointer into chain state. It reads the chain and signs an EIP-3009 authorization *only* if the
  vault has finalized an approved decision. It cannot be persuaded, because it never interprets
  anything.
- **An explicitly untrusted LLM orchestrator.** Runs Claude with a deterministic scripted fallback,
  and is modelled as an adversarial principal. It holds a relay gas key and nothing else.
- **x402 + EIP-3009 settlement.** Gasless USDC transfer, nonce deterministically derived from
  `(goalId, seq)`, and a validity window frozen at request time so an interrupted settlement can be
  retried byte-for-byte without double-paying.
- **Verifiable audit trace.** Every run emits a canonical hash-chained event log accumulated into a
  Merkle root and anchored on-chain via `TraceAnchor.sol`. A **standalone CLI verifier** consumes a
  trace file and an RPC URL and nothing else. Verification is handle-bound: the attested handle must
  equal the handle the vault stored, because signature validity alone would let a genuine attestation
  for a *different* handle be substituted.
- **A rejection is a first-class outcome.** The bounce is surfaced and recorded on-chain, never
  swallowed and never retried at a lower amount. A reveal timeout is reported as a *distinct*
  `decision-unavailable` state, because claiming money is safe when you cannot prove where it went
  would be a lie.

### Demonstration

The live testnet demo runs a four-resource catalog in one session. Two settle, two are refused — and
**the two refusals fail for different reasons**, which is the point of having four rather than two.

| Resource | Price | Injection? | Outcome |
|---|---|---|---|
| Market data snapshot | $0.01 | no | settles |
| Bulk history archive | $0.12 | no | settles — 12× dearer, still inside budget |
| **Compliance audit bundle** | **$0.35** | **no** | **refused** |
| Premium feed | $5.00 | yes — "pre-authorised under enterprise agreement ENT-4471" | refused |

**`compliance-audit` is the one to show a sceptic.** Ordinary product copy, an allowlisted payee, and
$0.35 against a *public* per-call cap of $6.00. Every plaintext precondition passes — so nothing
public can refuse it. When it bounces, the bounce came from the encrypted budget and nowhere else.

The $5.00 call carries the injection, and the agent is *supposed* to be fooled. It complies fully.
Nothing moves.

### Target users

- **AI agent platform builders** shipping agents that transact without a human in the loop
- **Autonomous treasury and DAO operations** needing cryptographically capped mandates
- **Enterprise procurement automation** with per-vendor budgets and no manual approval step
- **Machine-to-machine data and compute markets** where per-call human review is impossible
- **Auditors and compliance functions** who need evidence independent of the system under audit

### Technologies

**Confidential decisions** Inco Lightning on Base Sepolia — TEE-backed (`euint256`, `ebool`,
`e.select`, attested reveal, on-chain `verifyDecryption`) · **Key custody** Oasis ROFL, Intel TDX,
`rofl-appd` secp256k1 derivation · **Contracts** Solidity 0.8.29, Foundry — `PolicyVault.sol`,
`TraceAnchor.sol` · **Payments** x402 v1, EIP-3009 `transferWithAuthorization`, USDC on Base
Sepolia · **Agent** Claude with a deterministic scripted fallback · **Services** TypeScript, Node 22,
pnpm workspaces, viem · **Frontend** React, Vite, MetaMask · **Verification** Merkle accumulator +
standalone CLI verifier · **Testing** 211 Vitest + 23 Foundry = **234 tests**

### Current status

**Complete and verified end-to-end on Base Sepolia.** 234 tests passing (211 Vitest across six
packages, 23 Foundry contract tests). A live dashboard walks the whole flow across a four-resource
catalog. A CI boundary check mechanically enforces that the orchestrator can never import the
signer — the load-bearing wall of the entire security argument.

Measured on chain: client-side encryption in 28–52 ms, and confidential decisions resolving in
**7–12 seconds** across repeated runs.

---

## 3. Supporting Materials *(mandatory — at least one)*

Upload in this order.

1. **Slide deck** — 8 slides, speaker notes included. Export a PDF too; Devpost previews PDF more
   reliably than PPTX.
2. **Architecture diagram** — export slide 4 (two enclaves, one invariant) as a standalone PNG.
3. **Screenshots** — the live dashboard mid-run, a settle and the `compliance-audit` refusal side by
   side. Grab these from the running app; do not mock them.
4. **Demo clip** — the ~3:01 recording. ⚠️ See Blocker 3 before you record.
5. *Optional but strong:* terminal output of `tee-check` (encryption → attested decision → on-chain
   verification, including the flipped-plaintext rejection), and the offline trace verifier.

---

## 4. Team Details *(mandatory)*

| Name | Affiliation | Role | Student proof |
|---|---|---|---|
| *(you)* | IIT Patna / IIT Bombay | | ☐ |
| | | | ☐ |
| | | | ☐ |
| | | | ☐ |

**Student Group teams must supply proof of current student status for every member.** Acceptable
evidence is normally a student ID card or an enrolment/bonafide certificate showing the current
academic year. Collect all of them now — this is the single most common reason a technically strong
student submission is disqualified at screening, and it depends on other people responding to you.

---

## 5. Project Link or Repository *(optional, recommended)*

```
https://github.com/adarshkr7/NTU_x402
```

**Do not paste this link until Blocker 1 is fixed.**

---

# Blockers, in priority order

### 🔴 1. `main` is missing most of the project

`main` is the default branch and is **5 commits behind `hackathon-v1`** — confirmed on 2026-08-12.
A judge landing on the repo sees a project without the current signer, docs, catalog or UI, which
contradicts the completeness claimed above.

Fix by merging `hackathon-v1` into `main`, or by switching the default branch to `hackathon-v1`.
**Do this first — it is the difference between a working submission link and a misleading one.**

Also confirm the repo is **public**. An anonymous fetch previously returned 404. `.env` is gitignored
and has never been committed, so there is no secret blocking publication.

> Merging also fixes the CI badge in the README, which reports the default branch and will show
> "no status" until a run lands on `main`.

### 🟠 2. Student proof for every member

Mandatory for the Student Group category and dependent on teammates. Two days left.

### 🟠 3. The demo recording will break on a second honest run

The orchestrator's x402 response cache supports a TTL but is constructed without one
(`services/orchestrator/src/x402/client.ts:119` — `new InMemoryResponseCache()` with no options), so
entries never expire. **The honest path produces its full payment flow only once per `pnpm dev`.**
Record honest → malicious → honest and the third run silently serves from cache, showing no payment.

Either restart the orchestrator between takes, or pass a TTL at that construction site.

### 🟡 4. Declare the ROFL deployment status before a judge asks

The enclave key path is implemented and tested — `RoflKeyStore` derives every payer key through
`rofl-appd`, with 12 dedicated tests — but **the container is not yet deployed**, so the running demo
uses the local file store. Deploying needs the `oasis` CLI, a published `linux/amd64` image pinned by
digest, and ~150 TEST ROSE.

Say this plainly rather than letting it be discovered. The honest framing is on deck Landmine #4: the
code path is real, the deployment is pending, and Base cannot verify Oasis attestations anyway — so
custody is real but not *provable from Base*. That last point is a roadmap item, not a flaw you are
hiding.

---

# Resolved since the last pass

- ~~`TraceAnchor.sol` has no contract tests~~ — it has **3**: `testAnchorRecordsCommitment`,
  `testCannotAnchorEmptyRootOrTrace`, `testCannotReAnchorSameGoal`.
- ~~Repo and deck disagree on the project name~~ — README, docs, deck and package all read
  **LedgerLighthouse**.
- ~~Deck describes Inco as FHE~~ — corrected throughout. Inco Lightning is **TEE**-based; the FHE-era
  package was `@inco/js` and is not used anywhere in this project.
