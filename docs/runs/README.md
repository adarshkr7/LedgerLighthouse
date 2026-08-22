# Recorded runs

Evidence that the system did what it claims, on a public chain, at a stated time.
Kept because a demo that depends on a venue's wifi is a demo with a single point
of failure — and because a transaction hash is checkable by someone who does not
trust us, which a live walkthrough is not.

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
