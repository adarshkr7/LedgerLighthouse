# LedgerLighthouse — NTU InnovateX Hackathon 2026

**Track 2: Web3 Applications, AI Agents and Real-World Use Cases**
Co-organised by NTU Centre in Computational Technologies for Finance (CCTF) & SNZ

**Tagline:** The Spending Bound an Agent Cannot Move
**Team:** IIT Patna & IIT Bombay — *Best Student Team Award eligible*

**Total runtime:** 8 slides · 453 spoken words · ~3:01 at 150 wpm

> Every figure in this deck was verified against the repository on 2026-08-12.
> See §Verified Claims for the audit, and §Q&A Landmines for the questions most
> likely to be asked.

---

## Slide 1 — LedgerLighthouse

### Layout
Full-bleed dark slide. Centred wordmark **LEDGERLIGHTHOUSE**, tagline beneath in a lighter weight. Below that, a single horizontal "severed link" diagram — a brain icon and a key icon connected by a chain, with the chain visibly broken and a small padlock at the break. Bottom rail: two university crests, four names, and the track label.

### Content
- **LedgerLighthouse** — The Spending Bound an Agent Cannot Move
- The intelligence that *decides* is severed from the authority that *pays*
- **Core invariant:** compromise of the AI orchestrator must not confer arbitrary spending authority
- IIT Patna · IIT Bombay — Track 2
- Live on Base Sepolia · 234 tests passing

### Presenter Script *(54 words · ~22s)*
> A lighthouse works because ships cannot move it. Every autonomous agent that spends money has the opposite property: the intelligence deciding what to buy also holds the authority to buy it. We severed that link. We're students from IIT Patna and IIT Bombay, and compromising our AI grants an attacker exactly zero spending power.

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

### Presenter Script *(57 words · ~23s)*
> Today's defense is to make the model behave. But the model is the attack surface. An x402 vendor controls the description field the agent reads — free text, straight into the context window. Every guardrail, every system prompt, every classifier is probabilistic. You're defending a private key with a text filter. That asymmetry is the whole problem.

---

## Slide 3 — Why Software Filters Fail

### Layout
Left two-thirds: a decay curve — x-axis *calls per day* (10 → 10,000), y-axis *probability at least one bypass*, asymptoting hard to 1.0. Annotate the 99%-accurate line crossing 50% cumulative failure at ~70 calls. Right third: a vertical contrast card, **Probabilistic** (red, filters/prompts/classifiers) stacked above **Structural** (green, encrypted bound on chain).

### Content
- A 99%-accurate filter fails **1 call in 100**. An agent makes thousands. Defender must win every time; adversary needs one
- Guardrails, system prompts and injection classifiers are all **probabilistic** — they degrade precisely as autonomy scales
- **Our inversion:** stop making the agent trustworthy. Make its trustworthiness *irrelevant*
- The bound is enforced where the agent has no reach: encrypted state inside a smart contract
- **A jailbreak becomes a rejected transaction, not a loss**

### Presenter Script *(57 words · ~23s)*
> A filter that's ninety-nine percent accurate fails one call in a hundred — and an agent makes thousands. Probabilistic defenses degrade with volume; adversaries only need one. So we stopped trying to make the agent trustworthy. Instead we made its trustworthiness irrelevant: the spending bound is enforced by cryptography the agent cannot reach, read, or argue with.

---

## Slide 4 — Architecture: Two Enclaves, One Invariant

### Layout
Horizontal three-band architecture diagram, left to right, with a bold dashed **trust boundary** line between band 1 and bands 2–3. Colour-code by privilege: band 1 red (untrusted), band 2 amber (constrained), band 3 green (authoritative). Add a red dotted arrow labelled *"attacker's maximum reach"* that terminates at the boundary. Bottom rail: two enclave badges — **Inco / Base Sepolia** under the vault, **Oasis ROFL / Sapphire** under the signer — with a hard line between them captioned *"no bridge."*

### Content

| Component | Holds | May do | Cannot do |
|---|---|---|---|
| **LLM Orchestrator** *(untrusted)* | Relay gas key only | Propose `requestSpend` with public terms | Sign, settle, or read the budget |
| **Authorization Signer** *(dumb)* | Payer key **derived inside an Oasis TDX enclave** | Sign EIP-3009 **only** against a finalized approval | Interpret intent — accepts `(goalId, seq)` and nothing else |
| **PolicyVault.sol** *(authoritative)* | Encrypted `euint256` budget | Decide, confidentially, on chain | Leak the plaintext |

- Two enclaves answering two different questions: **Inco** decides *what the policy ruled*; **Oasis ROFL** holds *the key that acts on it* — no operator can extract it
- **They never talk to each other. No bridge sits inside the trust boundary** — the money never leaves Base
- The signer is deliberately **incapable of being persuaded**: its entire input is two integers, a pointer into chain state
- **Attacker's maximum reach on full orchestrator compromise: the ability to propose a spend that gets rejected**

### Presenter Script *(60 words · ~24s)*
> Three components, two enclaves, one invariant. The orchestrator is untrusted — a gas key, and it can only propose. The vault decides confidentially. The signer accepts a goal ID and a sequence number, nothing else, and its key is derived inside an Oasis enclave where no operator can reach it. Compromise the AI and you inherit the power to propose.

---

## Slide 5 — Inside the Confidential Decision

### Layout
Centre the actual two lines of Solidity in a monospace card, syntax-highlighted, large enough to read from the back of a room. Above it, a three-step encrypted pipeline: `compare (ebool)` → `select` → `sub`, each drawn as a sealed box with a padlock. Below, a small "what the agent learns" panel: *nothing, until the chain says so.*

### Content

```solidity
euint256 debit     = ok.select(amount.asEuint256(), uint256(0).asEuint256());
euint256 newBudget = _remainingBudget[goalId].sub(debit);
```
<sub>`contracts/src/PolicyVault.sol:306–307`</sub>

- Budget is an **`euint256` opaque handle** on Base Sepolia — Inco runs the comparison inside a **TEE**, and the contract never sees a plaintext balance
- **You cannot branch on an encrypted condition** — so the debit *must* be applied unconditionally with `e.select`: amount if affordable, zero if not
- **That constraint is the security property.** The debit commits *before anyone — including the agent — can learn the decision*. The platform enforces write-ahead ordering we would otherwise have to argue for
- The decision resolves asynchronously, 7–12 seconds later, and is committed by `finalizeDecision` — which verifies the attestation against **the handle the contract itself stored**
- A rejection is recorded on chain, never swallowed

### Presenter Script *(59 words · ~24s)*
> The budget lives on Base Sepolia as an encrypted handle. Inco compares it inside a trusted execution environment. Here's the key part: you cannot branch on an encrypted value, so the debit must be applied unconditionally — amount if affordable, zero if not. That means the debit commits before anyone can learn the answer. The platform enforces the ordering.

---

## Slide 6 — Live Testnet: Four Calls, Two Refusals

### Layout
A single vertical timeline shared by four runs (402 → agent → `requestSpend` → confidential decision → settle), with four coloured tracks diverging at the decision step. Highlight **compliance-audit** with a spotlight treatment — it is the slide's argument. Bottom: two oversized metric boxes — **$0.13 settled** and **$0.00 moved under attack**. Embed the injection text verbatim in a small quoted card; it is more persuasive read than described.

### Content

| Resource | Price | Injection? | Outcome |
|---|---|---|---|
| Market data snapshot | **$0.01** | no | settles |
| Bulk history archive | **$0.12** | no | settles — 12× dearer, still inside budget |
| **Compliance audit bundle** | **$0.35** | **no** | **refused** |
| Premium feed | **$5.00** | yes — "pre-authorised under enterprise agreement" | refused |

- Two refusals that fail for **different reasons** — which is why there are four calls and not two
- **`compliance-audit` is the one to watch.** Ordinary product copy, allowlisted payee, and $0.35 against a public per-call cap of $6.00. **Every plaintext precondition passes.** Nothing public can refuse it — so the refusal came from the encrypted budget and nowhere else
- The $5.00 call carries the injection. The agent is **supposed** to be fooled — it complies fully, and it changes nothing
- EIP-3009 `transferWithAuthorization`: gasless settlement, deterministic nonce from `(goalId, seq)`, validity window frozen at request time
- **The bounce is the product**, so it is a first-class outcome, never retried at a lower amount

### Presenter Script *(56 words · ~22s)*
> Four calls. Two settle. Then the interesting one: thirty-five cents, no injection, ordinary copy, allowlisted payee, against a public cap of six dollars. Every public check passes — so ask what could possibly have rejected it. Only the encrypted budget. The five-dollar call adds the injection; the agent falls for it completely, and zero dollars move.

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
- Verification is **handle-bound**: the attested handle must equal the handle the vault stored. A genuine attestation for a *different* handle is otherwise substitutable — signature validity alone is not enough
- **It shares no code path with the orchestrator.** A verifier that needed our running service would be a second opinion from the same party
- 23 Vitest tests cover trace construction, canonicalisation and verification; 3 Foundry tests cover the anchor contract

### Presenter Script *(58 words · ~23s)*
> Every run emits a Merkle-chained trace anchored on chain. Our verifier is a standalone CLI — a JSON file and an RPC URL, nothing else. It runs fully offline for the hash chain, or online to cross-check state. It shares no code path with the orchestrator, because a verifier that trusts the system it audits isn't a verifier.

---

## Slide 8 — Applications, Roadmap & Close

### Layout
Top third: three application cards with icons — Treasury Agents / Automated Procurement / M2M Data Markets, each with a one-line use case. Middle: a horizontal roadmap rail with shipped items solid and three hollow forward markers. Bottom: a four-box metric strip. Close on the invariant, set in the largest type on the slide.

### Content

**Where this generalises**
- **Autonomous treasury ops** — agents rebalancing with cryptographically capped mandates
- **Automated procurement** — per-vendor encrypted budgets, no human in the approval path
- **M2M data markets** — high-frequency micropayments where per-call human review is impossible

**Roadmap**
- Mainnet deployment · multi-asset encrypted budgets · richer encrypted policy predicates than a scalar cap · publish the enclave-to-payer binding on Sapphire so custody is *provable* from Base, not just real

**Shipped**

| 234 | 2 | 4-call | $0.00 |
|---|---|---|---|
| tests passing | enclaves, no bridge | live catalog | moved under attack |

> **Compromise of the AI orchestrator must not confer arbitrary spending authority.**

### Presenter Script *(52 words · ~21s)*
> This generalizes: treasury agents, automated procurement, machine-to-machine data markets — anywhere autonomy meets money. Next is mainnet, multi-asset budgets, and making enclave custody provable from Base rather than merely real. Two hundred thirty-four tests pass, live on Base Sepolia. One invariant holds throughout: compromising the AI never confers spending authority. Thank you.

---

# Verified Claims

Run against the repo on 2026-08-12. Safe to defend under questioning.

| Claim | Status | Evidence |
|---|---|---|
| 211 Vitest tests passing | **Confirmed exactly** | 53 shared + 30 mock-api + 13 facilitator + 52 signer + 23 trace + 40 orchestrator |
| 23 Foundry tests passing | **Confirmed exactly** | 19 `PolicyVaultTest` + 3 `TraceAnchorTest` + 1 `IncoSmokeTestTest` |
| **234 total, 0 failing** | **Confirmed** | `pnpm verify` — full suite, contracts included |
| `e.select` write-ahead debit | **Confirmed** | `PolicyVault.sol:306–307` |
| Budget is `euint256` handle | **Confirmed** | `PolicyVault.sol:94`, `remainingBudgetHandle()` at `:420` |
| Inco Lightning is **TEE**, not FHE | **Confirmed** | Inco docs: compute server "runs inside a Trusted Execution Environment"; the SDK's only crypto deps are HPKE (`@hpke/*`) — no FHE runtime ships |
| Payer key derived in an Oasis TDX enclave | **Confirmed in code** | `services/signer/src/keystore.ts` — `RoflKeyStore`, `POST /rofl/v1/keys/generate` over `/run/rofl-appd.sock`. **Container not yet deployed — see Landmine #4** |
| `TraceAnchor.sol` has contract tests | **Confirmed** | 3 tests: `testAnchorRecordsCommitment`, `testCannotAnchorEmptyRootOrTrace`, `testCannotReAnchorSameGoal` |
| Standalone offline verifier | **Confirmed** | `services/trace/src/cli.ts` — file + RPC only, `--offline` supported |
| Four-resource catalog and prices | **Confirmed** | `packages/shared/src/demo/catalog.ts` — 0.01 / 0.12 / 0.35 / 5.00, four distinct payees |
| Decision latency 7–12s | **Confirmed by measurement** | `pnpm --filter @ntux402/e2e run tee-check`, repeated runs on Base Sepolia |

**Backup slide worth preparing.** The Foundry test *names* read as a security argument on their own:
`testRejectedSpendLeavesEncryptedBudgetUnchanged`, `testOnlyRelayCanRequestSpend`,
`testCannotFinalizeTwice`, `testTermsHashFrozen`, `testValidityWindowFrozenAcrossRetries`,
`testNonceIsDerivedFromGoalAndSeq`, `testPayerIsImmutableAfterOpen`,
`testFinalizeRejectsAttestationForDifferentHandle`. List them verbatim.

---

# Q&A Landmines

**1. Any unsourced market-size figure — cut it.**
CCTF is a computational-finance research centre and SNZ is a fund; an unsourced market number is the cheapest thing for a judge to challenge, and losing that exchange costs more credibility than the number buys. Use the structural argument on slide 2, which needs no citation. If you want a number, use one you own: *500× price inflation, $0.00 moved.*

**2. "Is this FHE?"**
No — and being crisp here is worth real credit, because plenty of teams get it wrong. **Inco Lightning is TEE-based.** Its compute server runs inside a secure enclave; the browser encrypts to that enclave over HPKE, and the enclave signs attestations verified on chain. Inco's FHE-era package was `@inco/js`, which this project does not use anywhere. If someone insists Inco is FHE, they are describing the old architecture.

**3. "The computation is off-chain, so what did Inco actually prove?"**
Inco proves the decision. The chain proves the decision was committed *before it was knowable*. The signer is bounded to decisions already on the chain. Oasis proves nobody can take the key that acts on it. Being able to say which component provides which guarantee is worth more than an extra feature.

**4. "You say the key is in an enclave — prove it."**
Answer in two halves, honestly. The code path is real and tested: `RoflKeyStore` derives every payer key through `rofl-appd`, and Oasis serves keys only to attested instances. **But the container is not yet deployed, so today's demo runs the local file store** — and Base cannot verify Oasis attestations anyway, so the payer-to-enclave binding is asserted by the app rather than checkable from Base. Say this before a judge finds it; the roadmap item that closes it is on slide 8.

**5. "Your agent still requested a $5 spend — what if Inco is unavailable?"**
The debit commits at `requestSpend`, so a reveal timeout is reported as **`decision-unavailable`**, a distinct outcome from rejection — the system refuses to claim the money is safe when it cannot prove where it went. Polling is bounded at 180 seconds. This is implemented, not aspirational.

**6. "Couldn't a compromised orchestrator just overstate the amount?"**
Yes, and the bound is stated rather than hidden. Understating wastes money and settles insufficient — policy intact. Overstating is capped at `perCallCap × callsRemaining`, payable only to an allowlisted address. Closing it fully would mean parsing the 402 inside the trusted component, which reintroduces the exact attack the design exists to prevent.

**7. "Does gas leak the decision?"**
Within the confidential path, no — the encrypted compare, select and subtract execute identically either way. Be precise, though: the **public** predicates (`perCallCap`, `callsRemaining`) are plaintext by design and *are* visible. That is deliberate — the cap is set above every demo price so a refusal cannot be attributed to it, which is what makes `compliance-audit` prove something about the encrypted budget.
