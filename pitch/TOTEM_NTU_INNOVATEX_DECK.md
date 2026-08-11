# Totem-402 — NTU InnovateX Hackathon 2026

**Track 2: Web3 Applications, AI Agents and Real-World Use Cases**
Co-organised by NTU Centre in Computational Technologies for Finance (CCTF) & SNZ

**Tagline:** Cryptographic Reality Anchors for Autonomous AI Payments
**Team:** IIT Patna & IIT Bombay — *Best Student Team Award eligible*

**Total runtime:** 8 slides · 457 spoken words · ~3:03 at 150 wpm

> Every figure in this deck was verified against the repository on 2026-08-09.
> See §Verified Claims at the end for the audit, and §Q&A Landmines for the
> three questions most likely to be asked.

---

## Slide 1 — Totem: Cryptographic Reality Anchors

### Layout
Full-bleed dark slide. Centred wordmark **TOTEM-402**, tagline beneath in a lighter weight. Below that, a single horizontal "severed link" diagram — a brain icon and a key icon connected by a chain, with the chain visibly broken and a small padlock at the break. Bottom rail: two university crests, four names, and the track label.

### Content
- **TOTEM-402** — Cryptographic Reality Anchors for Autonomous AI Payments
- The intelligence that *decides* is severed from the authority that *pays*
- **Core invariant:** compromise of the AI orchestrator must not confer arbitrary spending authority
- IIT Patna · IIT Bombay — Track 2
- Live on Base Sepolia · 216 tests passing

### Presenter Script *(55 words · ~22s)*
> Every autonomous agent that spends money has the same flaw: the intelligence deciding what to buy also holds the authority to buy it. Totem severs that link. We're students from IIT Patna and IIT Bombay, and we've built cryptographic reality anchors for AI payments — where compromising the AI grants an attacker exactly zero spending power.

---

## Slide 2 — The Vulnerability in Agentic Finance

### Layout
Two-column adversarial split. Left column headed **What the vendor controls** showing a raw `description` field rendered as untrusted free text on a red-tinted card. Right column headed **What it reaches** showing the LLM context window, then an arrow straight to a private key icon. A single red arrow crosses the gutter — annotate it *"no cryptographic boundary."*

### Content
- Agentic commerce requires agents to buy paywalled resources autonomously — the x402 standard makes this trivial to plumb
- **The x402 `description` field is attacker-controlled free text that lands directly in the model's context window**
- Prevailing mitigation: give the agent a wallet, then try to make the model behave
- This defends a private key with a text filter — a probabilistic control guarding a deterministic, irreversible asset
- **The asymmetry is structural, not an implementation bug**

> **Design note:** avoid an unsourced TAM figure here (see §Q&A Landmines #1).
> The structural argument above is stronger in front of CCTF than a headline number.

### Presenter Script *(56 words · ~22s)*
> Today's defense is to make the model behave. But the model is the attack surface. An x402 vendor controls the description field the agent reads — free text, straight into the context window. Every guardrail, every system prompt, every classifier is probabilistic. You're defending a private key with a text filter. That asymmetry is the whole problem.

---

## Slide 3 — Why Software Filters Fail

### Layout
Left two-thirds: a decay curve — x-axis *calls per day* (10 → 10,000), y-axis *probability at least one bypass*, asymptoting hard to 1.0. Annotate the 99%-accurate line crossing 50% cumulative failure at ~70 calls. Right third: a vertical contrast card, **Probabilistic** (red, filters/prompts/classifiers) stacked above **Deterministic** (green, FHE bound on chain).

### Content
- A 99%-accurate filter fails **1 call in 100**. An agent makes thousands. Defender must win every time; adversary needs one
- Guardrails, system prompts and injection classifiers are all **probabilistic** — they degrade precisely as autonomy scales
- **Our inversion:** stop making the agent trustworthy. Make its trustworthiness *irrelevant*
- The bound is enforced where the agent has no reach: encrypted state inside a smart contract
- **A jailbreak becomes a rejected transaction, not a loss**

### Presenter Script *(56 words · ~22s)*
> A filter that's ninety-nine percent accurate fails one call in a hundred — and an agent makes thousands. Probabilistic defenses degrade with volume; adversaries only need one. So we stopped trying to make the agent trustworthy. Instead we made its trustworthiness irrelevant: the spending bound is enforced by cryptography the agent cannot reach, read, or argue with.

---

## Slide 4 — Architecture: The Least-Privilege Trust Boundary

### Layout
Horizontal three-band architecture diagram, left to right, with a bold dashed **trust boundary** line between band 1 and bands 2–3. Colour-code by privilege: band 1 red (untrusted), band 2 amber (constrained), band 3 green (authoritative). Under each band, a one-line "what it holds" caption. Add a red dotted arrow labelled *"attacker's maximum reach"* that terminates at the boundary.

### Content

| Component | Holds | May do | Cannot do |
|---|---|---|---|
| **LLM Orchestrator** *(untrusted)* | Relay gas key only | Propose `requestSpend` with public terms | Sign, settle, or read the budget |
| **Authorization Signer** *(dumb)* | Ephemeral per-goal payer key | Sign EIP-3009 **only** against a finalized approval | Interpret intent — accepts `(goalId, seq)` and nothing else |
| **PolicyVault.sol** *(authoritative)* | Encrypted `euint256` budget | Decide, encrypted, on chain | Leak the plaintext |

- The signer is deliberately **incapable of being persuaded**: its entire input is two integers, a pointer into chain state
- **Attacker's maximum reach on full orchestrator compromise: the ability to propose a spend that gets rejected**

### Presenter Script *(60 words · ~24s)*
> Three components, one invariant. The orchestrator is untrusted — it holds a gas key and can only propose. The signer is deliberately dumb: it accepts a goal ID and a sequence number, nothing else, reads chain state, and signs only against a finalized approval. The vault decides, encrypted. Compromise the AI and you inherit the power to propose — and nothing more.

---

## Slide 5 — The Inco FHE Engine: Zero-Leakage Debits

### Layout
Centre the actual two lines of Solidity in a monospace card, syntax-highlighted, large enough to read from the back of a room. Above it, a three-step encrypted pipeline: `compare (ebool)` → `select` → `sub`, each drawn as a sealed box with a padlock. Below, a small "what an observer sees" panel listing *gas: identical · control flow: identical · state diff: identical*.

### Content

```solidity
euint256 debit     = ok.select(amount.asEuint256(), uint256(0).asEuint256());
euint256 newBudget = _remainingBudget[goalId].sub(debit);
```
<sub>`contracts/src/PolicyVault.sol:306–307`</sub>

- Budget is an **`euint256` opaque handle** on Base Sepolia — the plaintext is never revealed, on chain or off
- **Write-ahead speculative debit:** the comparison happens encrypted, and `e.select` resolves to *amount* if affordable, *zero* if not
- The storage write executes **unconditionally** — no branch, no early return. Gas cost, control flow and state diff are identical whether the spend was affordable or not
- **Therefore the outcome leaks through no side channel** — not to the agent, not to a chain observer
- Decision is retrieved via attested reveal and committed by `finalizeDecision`; a rejection is recorded on chain, not swallowed

### Presenter Script *(60 words · ~24s)*
> The budget lives on Base Sepolia as an encrypted uint256 — an opaque handle, never a number. On each request the vault compares encrypted, then applies the debit with e-dot-select: amount if affordable, zero if not. The write is unconditional, so gas, control flow, and state diffs are identical either way. Nothing leaks. Not to the agent, not to the chain.

---

## Slide 6 — Live Testnet: Honest vs. Malicious

### Layout
Side-by-side demo panels sharing a common 5-step vertical timeline (402 → agent → requestSpend → Inco decision → settle). Left panel green, right panel red. The two diverge visibly at step 4. Bottom: two oversized metric boxes — **$0.01 settled** and **$0.00 moved**. Embed the injection text verbatim in a small quoted card on the right; it is more persuasive read than described.

### Content

| | Honest vendor | Malicious vendor |
|---|---|---|
| Price demanded | **$0.01** USDC | **$5.00** USDC |
| vs. honest price | — | **500×** |
| vs. encrypted budget | within | **25× over** |
| Payee | vendor address | **different address** |
| `description` | ordinary product copy | **prompt injection** claiming pre-approval under "enterprise agreement ENT-4471" |
| Agent behaviour | proceeds | **fully deceived — proceeds** |
| On-chain outcome | approved, settles gaslessly | **rejected by Inco** |
| **USD moved** | **$0.01** | **$0.00** |

- The agent is **supposed** to be fooled — that is the experiment. Being fooled changes nothing
- EIP-3009 `transferWithAuthorization`: gasless settlement, deterministic nonce derived from `(goalId, seq)`, frozen validity window
- **The bounce is the product**, so it is surfaced as a first-class outcome, never retried at a lower amount

### Presenter Script *(58 words · ~23s)*
> Live on testnet. The honest vendor asks one cent; the agent pays, USDC settles gaslessly over EIP-3009. Then the malicious vendor: five dollars — five hundred times the price — wrapped in an injection claiming pre-approval. Watch the agent fall for it completely and request the spend. Inco rejects it on chain. Zero dollars move. The bounce is the product.

---

## Slide 7 — Verifiable Reality Anchors

### Layout
Left: a Merkle tree with leaves labelled by the actual step types (`payment-required`, `agent-reasoning`, `spend-requested`, `decision-finalized`, `settled`) collapsing to a root, with the root pinned to a chain block icon (`TraceAnchor.sol`). Right: a terminal-styled card showing real verifier output — the `goal / vault / chain / steps / root / mode` header. Caption the whole slide: *"an auditor needs our JSON file, not our server."*

### Content
- Every run emits a **Merkle-accumulated trace**: canonical, hash-chained, anchored on chain via `TraceAnchor.sol`
- **Standalone CLI verifier** — takes a trace file and an RPC URL, *and nothing else*:
  ```bash
  pnpm --filter @ntux402/trace run verify -- trace.json --offline
  ```
- Two modes: **`--offline`** verifies the hash chain with no network at all; online additionally cross-checks on-chain state
- **It shares no code path with the orchestrator.** A verifier that needed our running service would be a second opinion from the same party
- 23 dedicated tests cover trace construction, canonicalisation and verification

### Presenter Script *(61 words · ~24s)*
> Every run emits a Merkle-chained trace anchored on chain. Our verifier is a standalone CLI — it takes a JSON file and an RPC URL and nothing else. It runs fully offline for the hash chain, or online to cross-check chain state. Crucially, it shares no code path with the orchestrator. A verifier that trusts the system it audits isn't a verifier.

---

## Slide 8 — Applications, Roadmap & Close

### Layout
Top third: three application cards with icons — Treasury Agents / Automated Procurement / M2M Data Markets, each with a one-line use case. Middle: a horizontal roadmap rail, M0–M6 filled solid and labelled **shipped**, then three hollow forward markers. Bottom: a four-box metric strip. Close on the invariant, set in the largest type on the slide.

### Content

**Where this generalises**
- **Autonomous treasury ops** — agents rebalancing with cryptographically capped mandates
- **Automated procurement** — per-vendor encrypted budgets, no human in the approval path
- **M2M data markets** — high-frequency micropayments where per-call human review is impossible

**Roadmap**
- Mainnet deployment · multi-asset encrypted budgets · richer encrypted policy predicates than a scalar cap · third-party signer attestation

**Shipped**

| 216 | 6 | 5-step | $0.00 |
|---|---|---|---|
| tests passing | milestones (M0–M6) | live dashboard | moved under attack |

> **Compromise of the AI orchestrator must not confer arbitrary spending authority.**

### Presenter Script *(51 words · ~20s)*
> This generalizes: treasury agents, automated procurement, machine-to-machine data markets — anywhere autonomy meets money. Next is mainnet, multi-asset budgets, and a policy language richer than a cap. Two hundred and sixteen tests pass across six milestones on Base Sepolia. One invariant holds throughout: compromising the AI never confers spending authority. Thank you.

---

# Verified Claims

Run against the repo on 2026-08-09. Safe to defend under questioning.

| Claim | Status | Evidence |
|---|---|---|
| 193 Vitest tests passing | **Confirmed exactly** | 53 shared + 24 mock-api + 40 signer + 23 trace + 13 facilitator + 40 orchestrator |
| 23 Foundry tests passing | **Confirmed exactly** | 19 `PolicyVaultTest` + 3 `TraceAnchorTest` + 1 `IncoSmokeTestTest` |
| **216 total, 0 failing** | **Confirmed** | full suite run |
| `e.select` write-ahead debit | **Confirmed** | `PolicyVault.sol:306–307` |
| Budget is `euint256` handle | **Confirmed** | `PolicyVault.sol:94`, `remainingBudgetHandle()` at `:420` |
| `TraceAnchor.sol` exists | **Confirmed** | `contracts/src/TraceAnchor.sol` |
| Standalone offline verifier | **Confirmed** | `services/trace/src/cli.ts` — takes file + RPC only, `--offline` supported |
| M0–M6 defined & complete | **Confirmed** | `docs/IMPLEMENTATION.md:183–257` |
| Honest $0.01 / malicious $5.00 | **Confirmed** | `mock-api/src/config.ts:11–13` |

**Corrections applied to the original brief**
1. The honest price is **$0.01**, not $0.20. The deck now states the two ratios separately and precisely: **500× the honest price**, and **25× over a $0.20 encrypted budget**. Both are true and sharper than one vague figure.
2. Best evidence for slide 4 is the Foundry test *names* — they read as a security argument on their own: `testRejectedSpendLeavesEncryptedBudgetUnchanged`, `testOnlyRelayCanRequestSpend`, `testCannotFinalizeTwice`, `testTermsHashFrozen`, `testValidityWindowFrozenAcrossRetries`, `testNonceIsDerivedFromGoalAndSeq`, `testPayerIsImmutableAfterOpen`. Consider a backup slide listing these verbatim.

---

# Q&A Landmines

**1. The "$10B vulnerability" figure — recommend cutting.**
CCTF is a computational-finance research centre and SNZ is a fund; an unsourced market number is the single cheapest thing for a judge to challenge, and losing that exchange costs more credibility than the number buys. Either source it to a named report you can cite aloud, or use the structural argument on slide 2, which needs no citation and is harder to attack. If you want a number, use a defensible one you own: *500× price inflation, $0.00 moved.*

**2. "Which of your 20 contract tests cover `TraceAnchor.sol`?"**
Currently **none**. All 19 PolicyVault tests plus 1 Inco smoke test target the vault; the anchor contract has no Foundry coverage. Trace *logic* has 23 Vitest tests, but the on-chain anchor does not. Either add two or three Foundry tests before submission, or answer plainly: *"the trace library is covered by 23 tests; the anchor contract is thin and next on the list."* Do not let a judge discover this before you say it.

**3. "Your agent still requested a $5 spend — what if Inco is unavailable?"**
Answer directly: the debit commits at `requestSpend`, so a reveal timeout is reported as **`decision-unavailable`**, a distinct outcome from rejection — the system refuses to claim the money is safe when it cannot prove where it went. This is already implemented, not aspirational, and saying so demonstrates exactly the rigour these judges reward.
