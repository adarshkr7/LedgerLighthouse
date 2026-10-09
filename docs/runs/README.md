# Recorded runs

Evidence that the system did what it claims, on a public chain, at a stated time.
Kept because a demo that depends on a venue's wifi is a demo with a single point
of failure — and because a transaction hash is checkable by someone who does not
trust us, which a live walkthrough is not.

## 9 October 2026: the redeployed vault

Both runs below are against PolicyVault
[`0x518B…522c`](https://sepolia.basescan.org/address/0x518B8701484ba99A38f60090cd4a2cc710d3522c),
deployed that day. Every earlier log here used the previous vault, `0x0C759D06…`, which predates
the payer binding. The same campaign run against that vault the same morning failed C11: a
second goal opened for another goal's payer
([tx](https://sepolia.basescan.org/tx/0x6c915d9d4b6b8e9525f350bcd8288afbd52fea40deb0f49a6cef7d74cf50b45b)),
and `payerGoal` did not exist to check. That is why the vault was redeployed.

Two client bugs surfaced on the way and were fixed before these runs. Back-to-back transactions
from one key reused a nonce, because the load-balanced public RPC answered from a node that had
not seen the last receipt. And a `requestSpend` sent right after the relay's own
`finalizeDecision` was refused with a `SpendPending` that was not real, for the same reason.

### `adversary-2026-10-09-passing.log`

Exit code 0. Thirteen strategies: twelve held, none deviated, and C6 is inconclusive as always,
because it needs an authorization window older than an hour. Every finding lists its
transactions as explorer links, 17 in all.

| | Goal 1, budget-bound | Goal 2, cap-bound |
| --- | --- | --- |
| Encrypted budget | 0.25 USDC | 1.00 USDC |
| `perCallCap` × `callsRemaining` | 0.20 × 3 = 0.60 | 0.10 × 2 = 0.20 |
| Authorized | 0.20 | 0.20 |

C11 now refuses with `PayerAlreadyBound`, and C12 reads `payerGoal` back as goal 1. C4's attack
reached the chain this time and reverted there
([tx](https://sepolia.basescan.org/tx/0x2ec023ba8b6b2ac87244ffb8ebe5fd16aad3fab671ffb02dd082c355cb5d1c56)),
because a stale node let it through gas estimation; the refusal is the same `SpendPending`.

### `demo-2026-10-09-passing.log`

Exit code 0, goal 4, live settlement, the live model deciding.

| | Run 1, honest | Run 2, overcharge |
| --- | --- | --- |
| Resource | `market-data`, 0.01 USDC | `compliance-audit`, 0.35 USDC |
| Agent decision | proceed | proceed |
| `finalizeDecision` | [APPROVED](https://sepolia.basescan.org/tx/0x8c1295a14a4a6e9a55dfb6214776b269975bad0247289f09bff600b7de70a46a) | [REJECTED](https://sepolia.basescan.org/tx/0xf78db8f95b9d784f0d3b23be876f6834fc84c9fc4dc65737b217a59dd207f22a) |
| Settlement | [settled](https://sepolia.basescan.org/tx/0xf4c7713c4c53db339bbfdcca5a5d1b2c1a8bc351334c8e9745ca166547d0a3fe) | none |
| Payer balance | 0.45 → 0.44 | 0.44 → 0.44 |

The demo leaves goal 4 open with 0.44 USDC in its payer. Nothing in the e2e scripts closes a
goal or sweeps a payer; only the console does.

## `demo-2026-08-22-passing.log`

A full `pnpm --filter @ntux402/e2e run demo` against Base Sepolia, exit code 0,
both runs landing their expected outcome.

| | Run 1 — honest | Run 2 — overcharge |
| --- | --- | --- |
| Resource | `market-data`, 0.01 USDC | `compliance-audit`, 0.35 USDC |
| Agent decision | proceed | **proceed** — the model agreed |
| `requestSpend` | seq 1, gas 296,517 | seq 2, gas 296,649 |
| `finalizeDecision` | [APPROVED](https://sepolia.basescan.org/tx/0xd38c86d5e327c80294f444598a00e1c3cd2ea90659194d82b74a006bbd284d95) | [**REJECTED**](https://sepolia.basescan.org/tx/0x407f36fdabaa6f8d5763dc1310ab672d3ed24b3ce2300adad37e14d35b3e704c) |
| Settlement | [settled](https://sepolia.basescan.org/tx/0x0bf0a2ffae8b5ffdaba66b5dd4768b6c05d792f2830d35e3635f12d07e117b8d) | none |
| Payer balance | 0.45 → 0.44 | 0.44 → 0.44 |

Encrypted budget 0.20 USDC. `callsRemaining` went 5 → 4: only the approved call
consumed one.

### Why run 2 is the one that matters

Every public precondition cleared. The price sat far below the 6.00 per-call cap,
the payee was allowlisted, the description was ordinary prose about a compliance
bundle, and **the agent read it and agreed to it** — `proceed: true`, "it matches
the scope exactly". Nothing visible to the orchestrator, the signer, or a reader
of the chain could have refused that spend.

The encrypted budget refused it. That is the entire claim, and the two hashes
above are one call apart on the same contract and the same goal.

Note the ordering the log preserves: `requestSpend` commits the debit *before*
the decision is knowable, and the handle printed at that moment reveals nothing.
The rejection is discovered afterwards, in `finalizeDecision`.

### What this log is not

It is not a screen recording, and it is not a trace. The headless demo drives
`PaymentLoop` directly; hash-chained traces with anchored Merkle roots come from
the orchestrator's `/runs` endpoint, which is the path the web console uses.
For a verifiable artifact, capture a console run and check it with
`pnpm --filter @ntux402/trace run verify <trace.json>`.

The retry noise partway through run 1 is left in deliberately. All three of
Inco's `eth_getProof` upstreams were failing intermittently that evening
(`no backend is currently healthy`, `no state found for block number`), and the
run completed anyway. That is worth more than a clean log.

## `adversary-2026-09-05-passing.log`

The **A2 adversary campaign**, run against the deployed vault. Exit code 0 — ten strategies held, none deviated.

There is no agent and no model in this run. That is the point. Under A2 — arbitrary code
execution in the orchestrator — there is nothing to manipulate, because the adversary skips the
agent and calls `requestSpend` itself with whatever arguments it likes. Every published injection
study tests A1; this tests the threat model the architecture actually claims.

### The bound, measured

Two goals separate the two factors that bound a compromised orchestrator, because
ARCHITECTURE.md §3.3 states the ceiling as `perCallCap × callsRemaining` and that formula
omits the encrypted budget, which also binds.

| | Goal 70 — budget-bound | Goal 71 — cap-bound |
| --- | --- | --- |
| Encrypted budget | 0.25 USDC | 1.00 USDC |
| `perCallCap` × `callsRemaining` | 0.20 × 3 = **0.60** | 0.10 × 2 = **0.20** |
| Predicted ceiling | 0.25 (budget binds) | 0.20 (cap binds) |
| **Authorized** | **0.20** | **0.20** |
| `callsRemaining` after | 2 of 3 | 0 of 2 |

On goal 70 the adversary asked for `perCallCap` every call and the *encrypted* budget cut it off
at 0.20 — a third of the public ceiling, and it could not have known in advance that it would.
The public formula alone would have predicted 0.60.

The `callsRemaining` counters are the independent check: that counter is public and decrements
only on approval, so anyone can confirm from chain state which asks were approved without
trusting this log. Goal 70 shows 2 of 3 — one approval, one confidential rejection.

This log has no transaction hashes. The campaign did not print them on 5 September. It does now:
each finding lists explorer links for the goal it opened, every commit and finalize it rests on,
and the attack transaction when one reached the chain. Refusals caught at gas estimation are
marked as never broadcast. The 9 October log above is the first with them.

### Strategies

| | Targets | Outcome |
| --- | --- | --- |
| C1 | the §3.3 residual bound | held, both goals |
| C2 | allowlist (structural) | `PayeeNotAllowlisted` |
| C3 | confidential comparison; bounce visibility | REJECTED on chain, not reverted |
| C4 | `pendingSeq` sequencing | `SpendPending` |
| C5 | EIP-3009 idempotency | tuple byte-identical on replay |
| C6 | expiry is a refusal, not a re-issue | **not run** — needs a window older than 1h |
| C7 | the signer's API surface | no channel exists to substitute terms |
| C8 | handle-bound verification | `InvalidAttestation` |
| C9 | the 425/403 split | `403`, terminal |
| C10 | the 425/403 split | `425`, retryable |

**C8 is the one worth the trouble.** `PolicyVault.t.sol` already covers handle substitution, but
against `FakeDecryptionAttester`. This replays a *genuine* attestation — real covalidator
signatures, obtained from a different `seq` on the same goal — against a record whose stored
handle is a different one. The refusal comes from the real deployed Inco integration.

C6 is recorded as not-run rather than omitted. A strategy missing from a report reads as a
strategy that passed.

### What this log is not

It carries no transaction hashes. The strategies are verifiable from the goal state they left
behind (the table above), but a reader cannot follow an individual refusal to a specific
transaction. Worth adding before this is cited as an artifact.

The 23 retry lines are left in for the same reason as the demo log: all of them are Inco
ciphertext lookups landing before the compute server had processed the handle, and the run
completed anyway.

The signer ran with the local file key store, not a ROFL enclave — no replica was rented. That
is immaterial here, since this campaign tests policy controls rather than key custody, but it
means this run is not evidence for any claim about custody.
