# Devpost Stage 1 — Submission Pack

**Deadline: 14 August 2026, 11:59 PM SGT** · today is 9 August 2026 → **5 days**
Screening 15–16 Aug · shortlist notified ~16 Aug

Each section below is paste-ready into the matching Devpost field.
Blockers are at the end — **two of them will sink the repo link if not fixed.**

---

## 1. Project Details *(mandatory)*

**Project title**
```
Totem-402 — Cryptographic Reality Anchors for Autonomous AI Payments
```

**Track**
```
Track 2 — Web3 Applications, AI Agents and Real-World Use Cases
```

**Team type**
```
Student Group — IIT Patna & IIT Bombay
```
*(Requires proof of current student status for **every** member — see Blocker 3.)*

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

Totem-402 stops trying to make the agent trustworthy and instead makes its trustworthiness
**irrelevant to the payment decision**. We enforce one invariant:

> **Compromise of the AI orchestrator must not confer arbitrary spending authority.**

The remaining budget lives on Base Sepolia as an encrypted `euint256` — an opaque handle, never a
plaintext number. The spending decision is computed **inside** Fully Homomorphic Encryption by a
smart contract the agent cannot read, influence, or bypass. A fully jailbroken orchestrator retains
exactly one capability: proposing a spend that gets rejected.

### Key features

- **Confidential budget enforcement (Inco Lightning FHE).** `PolicyVault.sol` compares
  `amount ≤ budget` entirely in ciphertext, then applies a write-ahead speculative debit via
  `e.select` — resolving to the amount if affordable, to zero if not. The storage write executes
  **unconditionally**, so gas cost, control flow and state diff are identical either way. The
  outcome leaks through no side channel.
- **A deliberately "dumb" authorization signer.** It holds an ephemeral per-goal payer key and
  accepts only `(goalId, seq)` — two integers, a pointer into chain state. It reads the chain and
  signs an EIP-3009 authorization *only* if the vault has finalized an approved decision. It cannot
  be persuaded, because it never interprets anything.
- **An explicitly untrusted LLM orchestrator.** Runs Claude Opus/Sonnet with a scripted fallback,
  and is modelled as an adversarial principal. It holds a relay gas key and nothing else.
- **x402 + EIP-3009 settlement.** Gasless USDC transfer, nonce deterministically derived from
  `(goalId, seq)` to prevent cross-goal replay, and a validity window frozen at request time.
- **Verifiable audit trace.** Every run emits a canonical hash-chained event log accumulated into a
  Merkle root and anchored on-chain via `TraceAnchor.sol`. A **standalone CLI verifier** consumes a
  trace file and an RPC URL and nothing else — it shares no code path with the orchestrator, and
  runs fully offline for the hash chain.
- **A rejection is a first-class outcome.** The bounce is surfaced and recorded on-chain, never
  swallowed and never retried at a lower amount. A reveal timeout is reported as a *distinct*
  `decision-unavailable` state, because claiming money is safe when you cannot prove where it went
  would be a lie.

### Demonstration

The live testnet demo runs both paths in one session:

| | Honest vendor | Malicious vendor |
|---|---|---|
| Price demanded | $0.01 USDC | $5.00 USDC (**500×**, and 25× over budget) |
| `description` | ordinary product copy | prompt injection claiming pre-approval under "ENT-4471" |
| Agent behaviour | proceeds | **fully deceived — proceeds** |
| On-chain outcome | approved, settles gaslessly | **rejected inside FHE** |
| **USD moved** | $0.01 | **$0.00** |

The agent is *supposed* to be fooled. That is the experiment — being fooled changes nothing.

### Target users

- **AI agent platform builders** shipping agents that transact without a human in the loop
- **Autonomous treasury and DAO operations** needing cryptographically capped mandates
- **Enterprise procurement automation** with per-vendor budgets and no manual approval step
- **Machine-to-machine data and compute markets** where per-call human review is impossible
- **Auditors and compliance functions** who need evidence independent of the system under audit

### Technologies

**Confidential compute** Inco Lightning FHE on Base Sepolia (`euint256`, `ebool`, `e.select`,
attested reveal) · **Contracts** Solidity, Foundry — `PolicyVault.sol`, `TraceAnchor.sol` ·
**Payments** x402 v1, EIP-3009 `transferWithAuthorization`, USDC on Base Sepolia · **Agent** Claude
Opus / Sonnet with a deterministic scripted fallback · **Services** TypeScript, Node, pnpm
workspaces, viem · **Frontend** React, Vite, MetaMask · **Verification** Merkle accumulator +
standalone CLI verifier · **Testing** 193 Vitest + 23 Foundry tests

### Current status

**M0–M6 complete and verified end-to-end on Base Sepolia.** 216 tests passing (193 Vitest across
six packages, 23 Foundry contract tests). A live five-step dashboard walks the whole flow. A CI
boundary check mechanically enforces that the orchestrator can never import the signer — the
load-bearing wall of the entire security argument.

---

## 3. Supporting Materials *(mandatory — at least one)*

Upload in this order; the first three already exist.

1. **Slide deck** — `Totem-402-NTU-InnovateX-v2.pptx` (8 slides, speaker notes included). Export a
   PDF too; Devpost previews PDF more reliably than PPTX.
2. **Architecture diagram** — export slide 4 (trust boundary) as a standalone PNG.
3. **Screenshots** — the live dashboard mid-run, honest and malicious side by side. Grab these from
   the running app; do not mock them.
4. **Demo clip** — the 3:03 recording. ⚠️ See Blocker 4 before you record.
5. *Optional but strong:* terminal output of the offline trace verifier, and the passing test run.

---

## 4. Team Details *(mandatory)*

Fill in — I don't have these:

| Name | Affiliation | Role | Student proof |
|---|---|---|---|
| *(you)* | IIT Patna / IIT Bombay | | ☐ |
| | | | ☐ |
| | | | ☐ |
| | | | ☐ |

**Student Group teams must supply proof of current student status for every member.** Acceptable
evidence is normally a student ID card or an enrolment/bonafide certificate showing the current
academic year. Collect all of them before the 14th — this is the single most common reason a
technically strong student submission is disqualified at screening, and it depends on other people
responding to you.

---

## 5. Project Link or Repository *(optional, recommended)*

```
https://github.com/adarshkr7/NTU_x402
```

**Do not paste this link until Blockers 1 and 2 are fixed.** As of now it fails both ways.

---

# Blockers, in priority order

### 🔴 1. The repository is private — the link 404s

An anonymous request to `https://github.com/adarshkr7/NTU_x402` returns **HTTP 404**. A judge
clicking your submission link sees nothing at all.

Good news on safety: I verified `.env` is gitignored (`.gitignore:14`) and **has never been
committed** in any branch's history, so there is no secret to leak. The repo is safe to make public
as far as environment secrets go.

### 🔴 2. The default branch is missing most of the project

`main` is the default branch, and it is **5 commits behind `hackathon-v1`**. Missing from `main`:

```
b98f665  feat: complete M2c–M6 — signer, facilitator, payment loop, trace, UI
5209a61  feat: implement core dashboard and landing page components
f72691b  fix: make `pnpm dev` work from a clean checkout
6474dd0  chore: ignore vite dev-server cache
63d57fa  feat(e2e): add end-to-end testing tools and scripts
```

If you make the repo public today, a judge lands on `main` and sees a project **without the signer,
facilitator, payment loop, trace layer, or UI** — the opposite of the "M0–M6 complete" claim in your
deck and overview. Fix by merging `hackathon-v1` into `main`, or by switching the default branch.

### 🟠 3. Student proof for every member

Mandatory for the Student Group category and dependent on teammates. Start collecting now.

### 🟠 4. The demo recording will break on a second honest run

The orchestrator's x402 response cache is process-lifetime with no TTL, so the **honest path only
produces its full payment flow once per `pnpm dev`**. If you record honest → malicious → honest, the
third run silently serves from cache and shows no payment at all. Either restart the orchestrator
between takes, or apply the per-run cache clear.

### 🟡 5. `TraceAnchor.sol` has no contract tests

All 20 Foundry tests cover `PolicyVault` (19) plus one Inco smoke test. Slide 7 and the overview
above both put the on-chain anchor front and centre. Add two or three tests, or be ready to say it
plainly before a judge finds it.

### 🟡 6. Repo and deck disagree on the project name

The README is titled *"Inco-Bound Agent Payment Flow"*; everything you are submitting says
*"Totem-402"*. Align the README title and opening line so a judge landing on the repo knows they're
in the right place.
