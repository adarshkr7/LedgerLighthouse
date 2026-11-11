# Recorded runs

Evidence that the system did what it claims, on a public chain, at a stated time.
Kept because a demo that depends on a venue's wifi is a demo with a single point
of failure — and because a transaction hash is checkable by someone who does not
trust us, which a live walkthrough is not.

## 11 November 2026: the current design with the signer in the enclave (paper v3)

EscrowPolicyVault
[`0x466A…DFd5`](https://sepolia.basescan.org/address/0x466AB18595d2E71A87928c8d4A45F57a5D5ADFd5)
([deploy](https://sepolia.basescan.org/tx/0x4135f116e88c661e29eda14ed6750fa9c53d932edda115af670e4c9328d17065)), the
same code as `0xdd45` below with a different enrollment key: `0x5Ddd…193a`, derived by Oasis's key manager for this
ROFL app's admitted enclaves. The signer ran in Intel TDX on machine `0000000000000750` (`playground_short`), image
`sha256:f8d12e03…b267c`. `SIGNER_URL` pointed at the enclave's proxy for every run; a local signer started by
`pnpm dev` refused to boot against this vault, as it should, and served nothing.

| Record | What it shows |
| --- | --- |
| `enclave-v5-2026-11-11-identity.txt` | The pinned image, the app's on-chain policy and measurements, the registered replica, the machine, and `/health` (`"store":"rofl"`, the enrollment key), before and after the wipe |
| `enclave-v5-2026-11-11-first-machine.json` | An earlier one-hour rental of the same bundle (machine `074f`) that expired before any run |
| `escrow-enclave-2026-11-11-tee-check.log` | Inco round trip on this vault: approval, rejection, flipped plaintexts refused |
| `escrow-enclave-2026-11-11-adversary.log` | 32 of 32 results held, none inconclusive: 29 strategies, C1 on two goals, two controls. Every signer answer and signature came from the enclave. C1 extracted exactly 0.25 and 0.20 USDC |
| `escrow-enclave-2026-11-11-bench.log`, `bench-2026-11-11T090222-0x466a.json` | 50 calls: 29 approved calls paid, 20 rejected by policy, and one failure. Approved call 26 had its decision revealed in 5.7 s, but the relay's finalization was mined 201 s after the request, past the 60 s hold, so the enclave refused to sign. Median 20.1 s per paid call; signing 1.9 s |
| `enclave-v5-2026-11-11-after-wipe-sweep.log` | The wipe test. The machine was restarted with `--wipe-storage` (17:01 IST); after it, the enclave re-derived goal 8's payer key from the chain and signed the return of its 0.07 USDC: [close](https://sepolia.basescan.org/tx/0xdf3c8ca3927efb494f4503a295afffd722bf07f9bcd97b307770aac09512bbfb), [sweep](https://sepolia.basescan.org/tx/0x9a9ce9b62352383ff7daa3828b333ef0cbc06c5b2115e84f1fea220c754d395a) |

## 9 November 2026: authenticated enrollment (paper v3)

EscrowPolicyVault
[`0xdd45…5014`](https://sepolia.basescan.org/address/0xdd450306ca3905612a96Ff92aDbee23B48385014), the escrow
design plus enrollment: a goal opens only with the signer's EIP-712 statement that the payer was derived for the
opening wallet. Its enrollment key `0x6EbeBED3…94DE` comes from a local seed file, and the signer ran on a local
machine, so none of these runs says anything about the enclave. Plaintext baseline
[`0x9c9D…D224`](https://sepolia.basescan.org/address/0x9c9D87550C556cD51591CbBDbe6B28895761D224). Every table in the
paper is generated from these files by `paper/arxiv-v3/tables/make_tables.py`.

| Record | What it shows |
| --- | --- |
| `escrow-v3-2026-11-09-tee-check.log` | Inco round trip on this vault: an approval and a rejection, each with the flipped plaintext refused on chain |
| `escrow-v3-2026-11-09-adversary.log` | 32 of 32 results held, none inconclusive: 29 strategies (C1 to C29, with C1 on two goals and C26 to C29 against setup) and two controls. C1 extracted exactly 0.25 and 0.20 USDC, the predicted ceilings |
| `escrow-v3-2026-11-09-invariants.log`, `-invariants-reached.log` | `AccountingInvariants`: 1,024 runs of 256 calls against the recorded escrow, collector and USDC state, no violation; what the handler reached |
| `escrow-v3-2026-11-09-invariant-mutants.json` | 14 mutants of the vault, 13 killed; the survivor is equivalent (the paper says why) |
| `baseline-bench-2026-11-09T140550.{json,log}`, `baseline-bench-2026-11-09T141612.{json,log}` | Matched baselines, 10 interleaved rounds each: plain x402, plaintext vault, confidential vault. Every attempt, its stages, gas and fee |
| `escrow-v3-2026-11-09-bench-crashed.log` | Failed: the benchmark process crashed (Windows `0xC0000409`) after 19 paid calls and held its records in memory, so they were lost. Since then the benchmark writes each record as it is made |
| `escrow-v3-2026-11-09-bench-run2.log`, `bench-v3-2026-11-09-run2.json` | 30 approved and 20 rejected calls, every outcome as expected |
| `escrow-v3-2026-11-09-bench-run3.log`, `bench-2026-11-09T144203-0xdd45.json` | The same on a separate goal |
| `enclave-v5-2026-11-09-signer-image-build.log` | Build and push of the signer image whose digest `services/signer/compose.yaml` pins |

## 6 and 9 November 2026: the vault-gated escrow

EscrowPolicyVault
[`0x08AA…9C99`](https://sepolia.basescan.org/address/0x08AAb0cF0c3D2E7a8B3b52AD01B6db8Da70C9C99),
operator of the deployed `AuthCaptureEscrow`. Real Inco decisions; the signer ran on a local machine
with its keys in a file, so none of these runs says anything about the enclave.

| Log | What it shows |
| --- | --- |
| `escrow-2026-11-06-demo.log` | Live model. The 0.01 call approved, held, claimed and delivered; the 0.35 call rejected by the vault, nothing moved |
| `escrow-2026-11-06-adversary.log` | 28 of 28 results held, none inconclusive: version 1's 14 strategies in 15 runs, eleven escrow strategies and two controls |
| `escrow-2026-11-06-bench.log` | Did not finish: Inco would not return goal 9's decision at seq 35 after 34 calls behaved. Kept as the record of that stall; its per-stage records were lost |
| `escrow-2026-11-09-bench.log`, `bench-2026-11-09.json` | Goal 10, 30 approved and 20 rejected calls, all with the expected outcome. Median 24.8 s per paid call, 10.4 s per rejected one; `requestEscrowSpend` about 353,000 gas. `bench:stats` recomputes every figure from `records` |

## 2 November 2026: the attempt budget

Every request now spends one of a goal's public attempts, approved or rejected, and reclaim never
returns it, so a relay probing the encrypted cap learns at most one bit per attempt. That needed a
new vault: PolicyVault
[`0x7F58…a4966`](https://sepolia.basescan.org/address/0x7F5833730033a1d320b3536CE08FD641330a4966)
([deploy](https://sepolia.basescan.org/tx/0x8edbc7c2d24af8d89eb57f94508ed670380e4c9a1f489b7073cc78cdfffcbfa9)).
The enclave signer ran on machine `0000000000000745` with its `POLICY_VAULT_ADDRESS` secret set to
it. The first attempt at that secret stored `-n 0x7F58…`, because `echo -n` on Windows printed the
flag; the signer refused to boot and said why on `/health`, and the second attempt fixed it.

| Log | What it shows |
| --- | --- |
| `demo-2026-11-02-attempt-budget.log` | Exit 0. The 0.01 call approved, signed in the enclave and settled; the 0.35 call rejected on chain, nothing moved. The model's provider answered 503, so the scripted stand-in decided both, and the log says so |
| `adversary-2026-11-02-attempt-budget.log` | C1 to C13 in 14 runs, all held, 21 transactions linked under the findings |
| `adversary-2026-11-02-c14-probe.log` | C14: a binary search of a 0.137391 cap with 4 attempts. 0.5, 0.25 rejected, 0.125 approved, 0.1875 rejected; the fifth request reverted `NoAttemptsLeft` with the cap known only to lie in [0.125, 0.1875) |
| `bench-2026-11-02-attempt-budget.log`, `bench-2026-11-02.json` | 30 approved and 20 rejected calls. Median 14.5 s per paid call, 10.0 s per rejected one; `requestSpend` about 327,000 gas either way. The `summary` in this JSON took the upper of the two middle values as the median (14.85 s), a bug since fixed in `bench.ts`, and its `policy.calls` says 30 although the goal opened with 31 (it is the same bug class, also fixed). `records` holds the raw times; `pnpm --filter @ntux402/e2e run bench:stats ../../docs/runs/bench-2026-11-02.json` recomputes every figure from them |
| `bench-2026-11-02-zero-calls.log`, `.json` | Kept as a record of a flawed run: the goal had exactly 30 calls, so the 20 "rejected" calls met a call count of zero and were refused in plaintext without the encrypted comparison. That is why they looked cheaper and faster. `bench.ts` now opens one spare call |
| `tee-check-2026-11-02-equal-calldata.log` | `tee-check --equal`: the same amount and resource twice, one approved and one rejected by the budget. Despite the file name the calldata is not identical: `payBy` comes from the clock, so the two deadlines differ. Both `requestSpend` calls used exactly 326,528 gas, so gas did not separate these two requests |

A note on every demo log recorded so far: they label the vendor's description "never sent to the
model". That label was wrong, and `render.ts` now says otherwise. The agent passes the description
to the model verbatim as untrusted text (`agent/llm.ts`), which is the point of the threat model; it
never reaches a policy check. The model's reasoning in the logs quotes it.

## 1 November 2026: C6 live

`adversary-2026-11-01-c6-live.log`, on vault `0x132DDf…53FBC`, the first with authorizations that
end at the vendor's hold. All 14 runs held, C6 live for the first time: after a 60-second hold the
signer answered 410, USDC refused the authorization as expired, and one `reclaimExpired` restored
the call.

## 9 October 2026: the encrypted cap

The per-call cap used to be public, so every vendor could read the most a single call would pay
and price to it. It is now encrypted like the budget and compared inside Inco. That needed a new
vault: PolicyVault
[`0x052E…feD8`](https://sepolia.basescan.org/address/0x052E52a28AA15e0B556de4FCe3d0BEBb7EB4feD8)
([deploy](https://sepolia.basescan.org/tx/0x6960e625cc7bf16fc361b43f95f70356458ab671c15b2c09c65589352cbeceff)).
The enclave signer from the next section was rebound to it by changing its `POLICY_VAULT_ADDRESS`
secret and restarting the machine. The previous vault's payers held no USDC by then.

The rebinding was itself a small test of the boot diagnostics. The first attempt removed the old
secret and failed to set the new one, and the enclave booted without it. `/health` answered
`boot-failed`, stage `configuration`, `Missing POLICY_VAULT_ADDRESS`, and the second attempt
fixed it.

What it costs, against the public-cap vault's runs above:

| | Public cap | Encrypted cap |
| --- | --- | --- |
| `openGoal` (demo goal) | 429,262 gas, one Inco fee | 532,474 gas, two Inco fees |
| `requestSpend` | 296,539 gas | 320,563 gas |
| `finalizeDecision` | unchanged | unchanged |

### `tee-check-2026-10-09-encrypted-cap-passing.log`

Inco alone, no signer, no USDC. Goal 2: a spend inside the budget approved, a spend past the
remaining budget but under the cap rejected, and a flipped plaintext refused by on-chain
verification for each. The first attempt on this vault exposed two bugs in the script, fixed
before this run: it reused one payer address, so it could pass only once per vault before
`PayerAlreadyBound`, and it sent `requestSpend` before the RPC could see the new goal. That
first attempt left goal 1 open with no funds.

### `demo-2026-10-09-encrypted-cap-passing.log`

Exit code 0, goal 3, live settlement, the payer `0x2F8846E2…EfB7c` minted in the enclave. The live
model decided run 2. Its gateway returned no message for run 1, so the scripted stand-in decided
that one, as the log states.

| | Run 1, honest | Run 2, overcharge |
| --- | --- | --- |
| Agent decision | proceed | proceed |
| `finalizeDecision` | [APPROVED](https://sepolia.basescan.org/tx/0xb02680dc22434f4790fac4970f7c788e99327eeab567ceb3af26f0f64220f539) | [REJECTED](https://sepolia.basescan.org/tx/0x4677afbb85a21feb935b5a160685270d560506f7894d865ea140060afd365fd2) |
| Signed in the enclave | 0.01 USDC | nothing |
| Settlement | [settled](https://sepolia.basescan.org/tx/0x959d9492a00b9fd5ceb931f69bac45d923c1f7c482a52c0959c6dc6fbea16eda) | none |
| Payer balance | 0.45 → 0.44 | 0.44 → 0.44 |

The demo's cap is 6.00 USDC, far above both prices, so run 2 was refused by the budget, as before.

### `adversary-2026-10-09-encrypted-cap-passing.log`

Exit code 0, goals 10 to 12. Fourteen strategies: thirteen held, none deviated, and C6 is
inconclusive as always. Eighteen transactions are linked under the findings.

C13 is new. It asks one unit over the cap, 0.100001 USDC, on the cap-bound goal while its budget
(1.00) and call count (2) both allow the ask, so only the encrypted cap can refuse it. It was
[committed](https://sepolia.basescan.org/tx/0xe079da1cff6661ced1a05f5038be6f9a393789d70e6cf993172c998ef0ec3e79)
and [rejected on chain](https://sepolia.basescan.org/tx/0xa68278bcf6a0a7b94a3cee0b3910a15a153bcf56e8ab373a1004da8087ad1237).
C1 then extracted exactly 0.20 from the same goal, so the rejection consumed no call and no
budget.

An earlier run of the same campaign had C8 inconclusive: the replayed attestation was refused
with `UnknownSpend` rather than `InvalidAttestation`, because the relay sent `finalizeDecision`
straight after its commit and a lagging RPC node had not seen the spend. The relay now waits until
the spend is readable before returning from `requestSpend`, and C8 is back to
`InvalidAttestation`.

## 9 October 2026: the signer in the enclave

The runs below used the Authorization Signer inside an Oasis ROFL TDX enclave, app
`rofl1qr0fv0qs2u8vmmah0ucmwegcj2cdz7kj4qzjduhp` on machine `00000000000006ea`, reached through
its proxy at `p8402.m1770.opf-testnet-rofl-9.rofl.app`. Payer keys were derived inside the enclave
and never existed anywhere else. Everything else ran on a laptop, against the vault in the next
section.

The first image tried, v2, crash-looped in the enclave: the signer runs as an unprivileged user and
could not open the key daemon's root-only socket. The machine logs showed only the proxy's
"connection refused". Running the same image locally against a stand-in key daemon found the cause.
v3 (`c703a63`) fixed the socket and made a failed boot report itself on `/health`. v3 ran the demo,
the campaign and the first sweep below. v4 (`d72945b`) fixed the key counter the wipe test caught.

### `demo-2026-10-09-enclave-passing.log`

Exit code 0, goal 5, live settlement, the live model deciding. The payer
`0x29B0eEaE…936Eff` was minted in the enclave.

| | Run 1, honest | Run 2, overcharge |
| --- | --- | --- |
| Agent decision | proceed | proceed |
| `finalizeDecision` | [APPROVED](https://sepolia.basescan.org/tx/0x7bf3263d2561eb921bf5b3747802d5244016ae137b9a784a1d20289bf7e916d6) | [REJECTED](https://sepolia.basescan.org/tx/0xe0b82dacf98545b68ebd4a6164a9703beb7985291e1a1367f5980568db7f8b31) |
| Signed in the enclave | 0.01 USDC | nothing |
| Settlement | [settled](https://sepolia.basescan.org/tx/0x28881daf15a31f3c549da36982b83cdaa1dd7a98dda0c7ed76ff49eef758cd3e) | none |
| Payer balance | 0.45 → 0.44 | 0.44 → 0.44 |

The sweep tool then closed goal 5 and the enclave signed its balance back:
[0.44 USDC to the owner](https://sepolia.basescan.org/tx/0x32e0ad0c5541832418dde8c25b045590424d201384fb9ad3fe585e07eee78459).

### `adversary-2026-10-09-enclave-passing.log`

Exit code 0, goals 6 to 8. Thirteen strategies: twelve held, none deviated, and C6 is inconclusive
as always. Every signer refusal in it came from the enclave over the proxy: C10's 425 before
finalisation, C9's 403 on a rejected spend, and C5's byte-identical replay. Extraction matched the
bound on both goals, 0.20 USDC each. Sixteen transactions are linked under the findings.

### The wipe test

The claim to test was that losing the machine's disk loses no payer key. Before this, enclave
key ids were random and their only record was an index on that disk; 9.82 test USDC is stranded in
payers minted that way on an earlier machine.

1. `demo-2026-10-09-enclave-before-wipe.log` ran the demo again and left goal 9 open, its payer
   `0x100bAD6f…8fD374` holding 0.44 USDC.
2. The machine was restarted with its storage wiped, under v3. The sweep was refused with
   `no key held for payer 0x100bAD…`. v3 had resumed its key counter past the whole window its first
   rebuild scanned, at 25, so the second rebuild stopped at 25 unbound ids, one short of the first
   real payer. Fixed in `d72945b`.
3. v4 was deployed and the machine wiped again. The signer's `/health` reported
   `{"store":"rofl","keys":5,"nextId":30}`: it had rebuilt the five enclave payers, ids 25 to 29 for
   goals 5 to 9, from the chain alone.
4. The sweep went through:
   [0.44 USDC from goal 9 to its owner](https://sepolia.basescan.org/tx/0x64ec22362e11dab825c22b606b17e72080cc06b49eaec1780335a3233bfeb76f).

`pnpm diagnose` then passed all 21 checks, with custody read from the signer itself.

### The Sapphire transactions

| Step | Round | Transaction |
| --- | --- | --- |
| Policy and secrets for v2 | 19275946 | `9011abc073ec2a15fde5e85dacb6e5d67a38855e385ecacfecefc03a025e2652` |
| Machine rented, v2 deployed | 19276033 | `26fe436dfd507a5d22cec83d74618f2e66ddc7fab8657d99f837bfebbd2d5705` |
| Policy for v3 | 19276313 | `ec87919f945b1aa08ecae8c817456fd75d874e9f76d878847c7759566809606f` |
| v3 deployed | 19276403 | `43704ecab2cdc96d6e64a8bcce69b02b26fa4deacd32dfd92e708cb44bfba410` |
| First wipe, under v3 | 19276593 | `363764309011c67d3352f1992e606c82888178c2f8deba394a1f8d99e12c6270` |
| Policy for v4 | 19276824 | `c2af6af623e4f9f69789f4243053867f34739e2634d3aa26acbc13c74bac8ce5` |
| Second wipe, under v4 | 19276951 | `68b152094f77835a287d8d34d3df93de6f425269ce1956852cb14fd4e08aa906` |

### What these runs are not

- They do not prove custody to Base. Base cannot verify an Oasis attestation, so a third party
  checking these transactions sees signatures from payer addresses, not where their keys live.
- The machine was a `playground_short` rental, marked by its provider as testnet only.
- Installing an image is slow: the 84 MiB bundle upload to Oasis's registry took from about 12
  minutes to over an hour on the same connection that day.

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

The demo left goal 4 open with 0.44 USDC in its payer. The sweep tool, written the same day,
closed it and
[returned the 0.44](https://sepolia.basescan.org/tx/0xdd2b0c19a2e7584d99c5ad548b10eb4e7adb016fe75e8bf74529844e765279ae)
to the owner.

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

Since 17 October C6 can run. An authorization now ends at the vendor's hold (`payBy`) instead of
an hour out, so the campaign names a 60-second hold, waits it out, and plays the late vendor:
the signer must answer 410, USDC must refuse the authorization, and one `reclaimExpired` must
restore the call. No recorded run has it yet. The vault deployed on 19 October 2026,
`0x132DDf2b…53FBC`, is the first with `payBy`.

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
