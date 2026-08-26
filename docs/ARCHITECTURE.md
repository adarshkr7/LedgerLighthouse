# LedgerLighthouse — Architecture

Confidential, policy-controlled payments for autonomous agents.

Every claim below is stated against deployed state. Where something cannot be checked from a public
chain, it is marked and the reason is given.

**Provenance markers.** Each guarantee is attributed to whoever provides it:
**[CHAIN]** checkable by anyone with a public RPC · **[INCO]** trusted to Inco Lightning ·
**[OASIS]** trusted to Oasis ROFL · **[BUILD]** our own code · **[ASSUMPTION]** trusted without proof.

---

## 1. The ledger of record

Base Sepolia, chain id `84532`. Both contracts are source-verified.

| Contract | Address | Deployment tx |
|---|---|---|
| `PolicyVault` | [`0x0C759D06a1c14F43852D7b078Db2f8C342F15921`](https://sepolia.basescan.org/address/0x0C759D06a1c14F43852D7b078Db2f8C342F15921) | [`0xcbf4da83…c013ee`](https://sepolia.basescan.org/tx/0xcbf4da835639699cf7ae7d472fed635a145c6df97381300941ddc9ba7fc013ee) |
| `TraceAnchor` | [`0x065d5E16160159cAB7D841818aBc92b4E85D5818`](https://sepolia.basescan.org/address/0x065d5E16160159cAB7D841818aBc92b4E85D5818) | [`0x068c2d88…2f9900`](https://sepolia.basescan.org/tx/0x068c2d8883bfe2a294164da805274905aa33c85f2a68a27ab1c06892972f9900) |

Settlement asset: USDC at [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e).

Sapphire testnet: ROFL app `rofl1qr0fv0qs2u8vmmah0ucmwegcj2cdz7kj4qzjduhp`, both enclave measurements
whitelisted in its on-chain policy, one replica attested and running. [OASIS]

Live transactions produced by the deployed system:

| What | Transaction |
|---|---|
| `finalizeDecision` — APPROVED | [`0xd38c86d5…284d95`](https://sepolia.basescan.org/tx/0xd38c86d5e327c80294f444598a00e1c3cd2ea90659194d82b74a006bbd284d95) |
| `finalizeDecision` — REJECTED | [`0x407f36fd…3e704c`](https://sepolia.basescan.org/tx/0x407f36fdabaa6f8d5763dc1310ab672d3ed24b3ce2300adad37e14d35b3e704c) |
| `transferWithAuthorization` — settled | [`0x0bf0a2ff…117b8d`](https://sepolia.basescan.org/tx/0x0bf0a2ffae8b5ffdaba66b5dd4768b6c05d792f2830d35e3635f12d07e117b8d) |

The rejection is on chain deliberately. An over-cap request lands and bounces visibly rather than
reverting into silence.

---

## 2. The invariant

> Compromise of the AI orchestrator must not confer arbitrary spending authority.

An agent that pays for things must read attacker-controlled text — HTTP bodies, error messages,
vendor descriptions — and must also decide when to spend. Putting both capabilities in one component
makes prompt injection a direct path to a drained budget.

A text filter is the usual answer and it is the wrong shape of control: probabilistic, guarding a
deterministic and irreversible asset. This design separates the capabilities instead.

**The component that reads the attacker's text has no spending authority. The component that grants
spending authority never reads the attacker's text.**

---

## 3. Trust model

| Component | Trusted for | Explicitly not trusted for |
|---|---|---|
| **AI Orchestrator** [BUILD] | Deciding *what* to request, sequencing, retries | Approving spend · holding a payer key · evaluating or modifying policy · reporting terms truthfully · instructing the signer |
| **Inco Lightning** [INCO] | Confidentiality of encrypted values · correct encrypted arithmetic and comparison · access control before decryption · unforgeable attestations over `(handle, value)` | Key custody · signing · running our logic · attesting our execution · liveness |
| **Oasis ROFL** [OASIS] | Deriving and holding the payer key inside an attested enclave; refusing to release it outside one | Any policy judgement · anything on Base |
| **`PolicyVault`** [BUILD] | Encrypted policy state, check-and-debit, `seq`, `termsHash`, approval records, attestation verification | Confidentiality of its own — that comes from Inco handles |
| **Authorization Signer** [BUILD] | Signing EIP-3009 only from a finalized on-chain approval record | Any policy judgement of its own |
| **Resource server** | Nothing | It *is* the source of attacker-controlled input |
| **x402 facilitator** | Relaying a signed authorization | Altering terms — the signature covers them |

### 3.1 What Inco is trusted for, precisely

That a handle produced by encrypted operations decrypts to the correct value; that only addresses
granted access can obtain that plaintext; and that an attestation over a `(handle, value)` pair is
unforgeable and verifiable on chain. **Nothing about our orchestrator, our signer, or our
application's correctness.**

Inco exposes no remote-attestation quote to applications, so its confidentiality is a vendor
assumption rather than a chain-checkable one. [ASSUMPTION]

### 3.2 Why the invariant holds

The orchestrator has exactly one power: calling `requestSpend` with public terms. It cannot

- **read the budget** — never granted access to that handle; [INCO]
- **alter the budget** — only the vault's own logic writes it; [CHAIN]
- **forge an approval** — the attestation is handle-bound and verified on chain; [CHAIN]
- **obtain a signature** — the signer reads the chain, never the caller; [BUILD]
- **reach the payer key** — it lives in an enclave the orchestrator cannot address. [OASIS]

### 3.3 The residual risk

**Understating the amount is not an attack.** If the orchestrator submits less than the 402 demands,
the signer signs that smaller amount, the facilitator settles it, and the resource server rejects the
payment as insufficient. Money is wasted; policy is intact.

**Overstating it is bounded, not eliminated.** A compromised orchestrator can submit an amount larger
than the 402 demanded — up to `perCallCap`, to an address already on the allowlist. Nothing in the
confidential check compares the submitted amount against the 402 body, because the vault never sees
the 402. The bound is the conjunction of `perCallCap`, the allowlist and `callsRemaining`:

```text
loss ceiling = perCallCap × callsRemaining, paid only to an allowlisted payee
```

Closing that gap entirely would require the vault to parse the 402 itself — putting
attacker-controlled text back inside the trusted component, which is the exact thing this design
exists to avoid.

**This ceiling is a design property, not a theorem.** It has not been formally modelled and no proof
is claimed for it.

### 3.4 Two TEEs, two different problems

Confidential computation answers *what the policy decided*. It does not answer *who holds the key
that acts on the decision*. Conflating them is how designs end up with a confidential policy guarded
by a private key in a JSON file.

| | Inco Lightning | Oasis ROFL |
|---|---|---|
| Answers | What did the policy decide? | Who holds the key? |
| Runs on | Base Sepolia | Sapphire testnet |
| Mechanism | Enclave compute over encrypted handles; attestations verified on chain | Enclave-derived `secp256k1` key, released only to attested instances |
| Failure if absent | The budget is public and the agent can read it | The payer key sits on disk and an operator can take it |

**They never communicate, and nothing bridges between them.** Inco rules on a spend; the enclave on
Oasis signs an EIP-3009 authorization for a spend Base has *already* approved. The money never leaves
Base. A bridge here would be a message relay inside the trust boundary — precisely what the invariant
forbids.

**The limit worth stating.** Base cannot verify Oasis attestations, so the binding between payer
address and enclave identity is asserted by the app rather than checkable by a third party from Base.
Custody is real; on-Base *provability* of custody is not.

### 3.5 What is not attested

The AI's reasoning, the orchestrator's execution, arbitrary application execution, or any enclave
measurement of our own code. The ROFL attestation covers key custody; it does not cover the
correctness of the policy logic running on Base.

---

## 4. The spend path

```text
AI Orchestrator → attacker-controlled 402 terms → PolicyVault → Inco confidential computation
→ APPROVE / REJECT → Authorization Signer (enclave key) → EIP-3009 → x402 facilitator → API
```

Everything left of `PolicyVault` is untrusted. Everything right of `APPROVE / REJECT` acts only on
verified on-chain records.

| Step | Where | Artifact |
|---|---|---|
| 1. Budget funded | `PolicyVault` | `euint256` handle; ciphertext bound to `msg.sender` |
| 2. Payer minted | ROFL enclave | Goal's `payer` address written to the vault |
| 3. `requestSpend` | `PolicyVault` | Public terms, `termsHash`, sequential `seq` |
| 4. Write-ahead debit | `PolicyVault` | `e.select` on the operand, committed *before* the decision is knowable |
| 5. Confidential evaluation | Inco | Decision handle; plaintext not yet available to anyone |
| 6. `finalizeDecision` | `PolicyVault` | `e.verifyDecryption`, bound to the handle the vault itself stored |
| 7. Signature | ROFL enclave | EIP-3009 authorization, released only against a finalized APPROVED record |
| 8. Settlement | USDC | `transferWithAuthorization` submitted by the facilitator |

**The decision is committed synchronously but learned asynchronously.** That gap is the crux of the
design, and §6 is about the ordering it forces.

---

## 5. Goal intake

The user's unconstrained authority is exercised once, in their own transaction. What remains
afterwards cannot be used to spend.

### 5.1 Confidentiality allocation

| State | Storage | Rationale |
|---|---|---|
| `remainingBudget` | `euint256` [INCO] | The headline secret — reveals strategy and willingness to pay |
| `perCallCap` | public [BUILD] | Bounds per-call size; readable by anyone, see §7 |
| `callsRemaining` | public [BUILD] | Bounds call count independently of spend size |
| `payTo` allowlist | public [BUILD] | Avoids `eaddress` comparisons and their fees |
| `asset`, `expiry`, `seq` | public [BUILD] | Not sensitive |
| requested `amount` | public [BUILD] | Deliberate — see below |

**The amount stays public, deliberately.** If it were encrypted, the orchestrator could submit one
ciphertext to the check and different terms to the signer. Public amounts let the signer bind its
signature to exactly what was checked. The confidential thing is the *budget*, not the price.

### 5.2 The opening transaction must come from the user

Encrypted inputs are bound to the address that produced them, and the on-chain conversion takes
`msg.sender`. The user sends `openGoal` from their own wallet, and **the orchestrator structurally
cannot open a goal.** A ciphertext prepared for any other address yields a handle `openGoal` cannot
use.

`openGoal` is `payable` because converting a client ciphertext into a handle is the one operation
here that charges the Inco fee — currently `1e12` wei. Comparison, select, sub and reveal do not,
which is why `requestSpend` is not payable.

### 5.3 Ordering: key before goal

The payer address is a *field* of the goal record, so the signer must derive the key and return its
address **before** `openGoal` is sent.

```text
signer derives key → returns address → user sends openGoal including it → user funds it
```

The other order forces either a second registration transaction or a mutable payer field — and a
mutable payer field lets whoever can write it redirect every future signature.

### 5.4 Handle lifecycle

- `allowThis` on the budget handle at `openGoal`, and again on the new handle after **every** debit.
  Without it the vault permanently loses the ability to compute over its own budget. This is the
  single most likely way to brick the system, which is why Foundry cheatcode tests cover it.
- Never on intermediate comparison results — they are transiently allowed within the transaction.
- It grants permanent, full access including decryption. It is not a narrow compute permission.
- Every debit produces a **new** handle; the old one still decrypts to the old balance forever.
  Budget history is protected only because access was never granted to anyone else.
- Inco has no delete, so goal closure is public state: `closeGoal` flips a flag and no further
  `requestSpend` succeeds.

### 5.5 Funding is a second, independent bound

The ephemeral payer holds only what the user sent it. Even if the confidential policy were bypassed
entirely, the loss ceiling is the funded amount. Fund it slightly **above** the encrypted budget so
the policy binds first — if the two numbers are equal, an observer cannot tell which control stopped
the payment.

---

## 6. Authorization

### 6.1 Where each condition is enforced, and why they differ

**Structural validity** — caller is the relay, goal open, not expired, payee allowlisted, amount
non-zero, no spend already pending. These `revert`. A malformed request is not a policy decision and
should never reach the chain as one.

**Policy** — `perCallCap`, `callsRemaining`, `remainingBudget`. These resolve into the *decision*
rather than reverting, **including the public ones**. An over-cap request must land on chain and
bounce visibly; if it reverted there would be no record.

Only the budget comparison touches Inco. The public predicates are evaluated in plaintext, because
branching on public data is unrestricted:

```solidity
record.decision = _evaluateAndDebit(
    goalId, amount, amount <= perCallCap[goalId] && goal.callsRemaining >= 1
);
```

### 6.2 The write-ahead ordering is enforced by the platform

The requirement is: **consume the sequence number and debit the budget before any authorization is
released.** Inco makes this the only expressible option, because you cannot write
`if (approved) { debit }` — branching on an encrypted condition is forbidden.

**Select the operand, not the result:**

```solidity
ebool ok       = _remainingBudget[goalId].ge(amount);
euint256 debit = ok.select(amount.asEuint256(), uint256(0).asEuint256());
euint256 next  = _remainingBudget[goalId].sub(debit);
next.allowThis();
```

The tempting shape — `select(ok, sub(remaining, amount), remaining)` — computes an underflowed
`euint256` on every rejected request and relies on nobody reading it. Selecting the operand first
means the subtraction is always well-defined.

Therefore **the debit is committed before anyone — including the orchestrator — can learn whether it
was approved.** An orchestrator that dislikes the answer cannot retroactively prevent the commit; it
already happened, in a transaction whose outcome was determined before the outcome was knowable.

`seq` increments unconditionally, so a rejected attempt still burns a sequence number and appears in
the trace.

### 6.3 What is and is not atomic

**Atomic in the commit transaction:** the new handle identifiers, the access grants, the `seq`
increment, the `termsHash`, the validity window, the reveal marking. Ordinary EVM state,
all-or-nothing.

**Not in that transaction:** the confidential computation itself. Encrypted operations are calls into
the Inco singleton, which emits events; the compute server processes them off chain afterwards.

The precise language is *commit transaction* (synchronous) and *decision retrieval* (asynchronous),
never "single atomic transaction."

The public call counter cannot be decremented at request time, because its decrement depends on a
decision that was not knowable then. It moves at `finalizeDecision`, and only on approval. The
encrypted budget does not have this problem — `e.select` already handled it.

### 6.4 Nonce and idempotency

```text
nonce = keccak256(abi.encode(goalId, seq))
```

`abi.encode`, not `encodePacked`, so no two distinct pairs can collide through concatenation.
Uniqueness holds because the payer key is per goal and `seq` is per goal and monotonic.

**The nonce alone is not the idempotency unit.** The token contract marks the whole *authorization*
used. A retry must reuse the entire tuple byte-for-byte — `from`, `to`, `value`, `validAfter`,
`validBefore`, `nonce`. If the signer regenerated `validBefore` from the current clock, the retry
would be a *different* authorization and could execute a second time.

So `validAfter` and `validBefore` are frozen into the on-chain record at `requestSpend` time and read
back verbatim on retry. The window is one hour, clamped to the goal's expiry so an authorization can
never outlive its goal. **Expiry is a refusal, not a re-issue.**

### 6.5 Three bindings that connect the decision to the signature

1. **`requestSpend` records `termsHash`** over `(goalId, seq, payer, amount, payTo, asset, resource,
   validAfter, validBefore)`. `payer` is included deliberately: the EIP-3009 tuple binds `from`, so a
   hash omitting it would not commit to which key signs.
2. **`finalizeDecision` verifies the attestation against the handle *this contract stored*.**
   Signature validity alone is insufficient — a genuine attestation for a different handle could
   otherwise be substituted. The claimed plaintext is covered by the signatures, so a wrong claim
   does not verify.
3. **The signer derives every EIP-3009 field from the on-chain record**, never from caller input. It
   cannot be asked to sign terms that were not checked, because it does not accept terms.

Anyone may call `finalizeDecision`. The attestation is unforgeable, so there is nothing to gain by
calling it, and requiring the relay would let a stuck relay wedge the goal.

### 6.6 The signer is deliberately dumb

One question — *"is `(goalId, seq)` finalized-approved on chain?"* — and if the answer is yes it signs
exactly what the chain froze. It has no notion of price and no way to be told one. Its refusal paths
are the specification:

| Condition | Response |
|---|---|
| RPC reports the wrong chain | `503` |
| Goal or spend unknown | `404` |
| Goal denominated in another asset | `409` |
| Not finalized yet | `425` — distinct from rejection, so the caller can tell "wait" from "never" |
| Finalized as rejected | `403` — terminal |
| Payer or nonce mismatch | `500` |
| Frozen window expired | `410` |
| EIP-712 domain mismatch vs the token's own `DOMAIN_SEPARATOR()` | `500` |

**Why it cannot be eliminated:** x402's `exact` scheme requires an EIP-3009 signature from the payer,
which must come from an EOA key. A contract cannot produce one.

**What ROFL changes:** the key is derived inside an attested enclave and never written to disk, so
"trusted to hold a key safely" stops being an assumption about operator discipline. What remains
assumed is the *code* — that the signer's refusal logic is what it claims to be, which is auditable
rather than cryptographic.

Every caller reaches the signer through `SignerClient`, which is the single place the service token
is read. A caller takes the client, never a URL.

### 6.7 Failure modes

| Situation | Handling |
|---|---|
| Settled, no data returned | Authorization is consumed; retry is safe and cannot double-pay |
| Facilitator timeout, unknown outcome | Re-submit the identical authorization tuple |
| Terms changed between 402 and retry | `termsHash` mismatch → signer refuses |
| Orchestrator understates the amount | Signer signs the recorded smaller amount; resource server rejects as insufficient |
| **Debit committed, decision unobtainable** [INCO] | Polling is bounded at 180 s and a timeout is a *reported outcome*, not a swallowed exception. The debit has already committed, so "decision unavailable" is a different state from "rejected" |
| Approved but never spent | Budget debited, not refunded |
| Two concurrent `requestSpend` calls | Rejected: `pendingSeq` must be zero. Strictly sequential per goal, because the public call counter is only decremented at finalisation |
| Missing `allowThis` after debit [INCO] | Vault can never compute over the budget again. Covered by cheatcode tests |
| Revealing the wrong handle [INCO] | Reveals are permanent. Only ever the per-request decision handle |

---

## 7. Confidentiality boundary, stated exactly

Encrypted on chain: the budget, as `euint256`; and the per-spend decision, until `finalizeDecision`
reveals it.

Public on chain: `perCallCap`, `callsRemaining`, allowlist membership, and every `requestSpend` term,
approval, and rejection record.

A vendor can therefore read the per-call ceiling and price immediately beneath it. That is a real
limitation of this deployment, visible in the contract state, and recorded here rather than deferred.

---

## 8. Trace and attestation

### 8.1 Format

```text
step_hash = H(prior_hash || step_type || H(inputs) || H(outputs) || timestamp || H(attestation))
```

The attestation term is present on every step, not only the attested ones: a step without one hashes
a fixed `"no-attestation"` marker, so absent and present-but-empty cannot collide.

Payment steps carry three independently verifiable extras:

```text
decision_handle   : bytes32   the ok handle for this spend
attestation_sigs  : bytes[]   verifiable through the Inco verifier
commit_tx         : bytes32   requestSpend transaction hash
```

Bounced attempts stay in the trace. A policy that never fires is indistinguishable from a policy that
does not work.

### 8.2 What an attestation covers

An attestation over a `(handle, value)` pair. In plain language: **"this specific encrypted value
decrypts to this specific result."** That is the whole claim. See §3.5 for what it does not cover.

### 8.3 Anchor the root, not the trace

Putting the full trace on chain leaks prompts, purchased data and vendor relationships, and costs
scale with volume. The root is 32 bytes and lets anyone holding the trace verify it. The standalone
verifier re-derives every step hash, recomputes the root, and cross-checks each attestation against
`PolicyVault` — needing only the file and a public RPC.

`TraceAnchor` stores one root per goal and requires the stored root to be zero, so the first run on a
goal claims the slot and later runs return `already`, unchanged. Two consequences follow: a goal whose
first run failed anchors that failure permanently, and on a multi-run goal the saved trace and the
anchored root describe different runs. Give a goal its own run if you want its anchor to mean
something specific.

---

## 9. Measured behaviour

Recorded on Base Sepolia against the deployed vault.

| Operation | Cost |
|---|---|
| Client-side encryption | 28–52 ms |
| `openGoal` | ~336,600 gas + `1e12` wei Inco fee |
| `requestSpend` | ~296,600 gas |
| `finalizeDecision` | ~101,400–106,800 gas |
| `closeGoal` | ~30,000 gas |
| `attestedReveal` after commit | 7–12 s, 1–2 poll attempts, 2 signatures |

A rejected decision resolves consistently faster than an approved one.

---

## 10. Limitations

**Not built:** encrypted allowlists, escrow-based x402 schemes, refund-on-timeout accounting,
multi-goal concurrency, mainnet deployment, on-Sapphire publication of the enclave-to-payer binding.

**Assumptions carried:**

1. **Signer code integrity.** The key is enclave-held [OASIS]; the refusal logic is auditable, not
   attested.
2. **TEE hardware trust.** Budget *confidentiality* rests on enclave vendor guarantees. Budget
   *integrity* does not — handle lineage and approval records are ordinary Base state.
3. **Off-chain ciphertext availability.** Confidential values live in Inco's storage.
4. **Attester honesty and liveness.** A stall halts spending — the safe direction, but the debit has
   already committed.
5. **Amount visibility.** Per-payment amounts are public by design. An observer learns what the agent
   paid, not what it could pay.

---

## 11. The defensible claim

> Every payment in an anchored trace corresponds to a confidential policy evaluation whose result was
> attested and verified on chain against the expected handle.

Not *"the agent behaved correctly."* Narrower, checkable, and still the claim that matters for a
spending agent.

Which component provides which guarantee: **Inco proves the decision. The chain proves the decision
was committed before it was knowable. The signer is bounded to decisions already on the chain. Oasis
holds the key that acts on it.**
