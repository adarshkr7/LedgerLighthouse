# Making it real for the finals

A plan for NTU InnovateX Track 2 finals: what to close, what to leave alone, and every
loophole a judge could find — with the fix for each.

The short version of the recommendation, up front, because it is the decision everything
else hangs off:

> **Do not move to mainnet for the final.** Close the gap your own README still declares —
> the enclave — make the demo unfailable on the day, and say the testnet part out loud.
> Mainnet adds real-money risk to a live demo and buys almost nothing with this audience.

The reasoning is in §2. If you disagree, §6 is the mainnet path costed honestly.

---

## 1. What is already real

Worth being precise, because "it's just a demo" undersells it and "it's production" oversells
it. Neither is what you have.

| Real today | Demo-shaped today |
| --- | --- |
| USDC moves by real EIP-3009 `transferWithAuthorization` | …on Base Sepolia, so it has no market value |
| Inco Lightning encrypts the budget and attests decisions on chain | — |
| The vault verifies the attestation against the handle it stored | — |
| AIsa charges **real money** per search ($0.008 / $0.016, measured) | — |
| An LLM makes the spend decision from vendor-controlled text | the model is `qwen3.7-flash`, because frontier ids are balance-gated |
| Traces are hash-chained, independently verifiable, and their roots anchored on Base Sepolia | — |
| Payer keys are per-goal and ephemeral | held in a **file on disk**, not an enclave |
| The facilitator settles for real | you run it, so "outside our trust boundary" is aspirational |
| The vendor is a real paid API behind a real 402, paid to a dedicated address | that address is still yours, so the USDC is recycled rather than earned |

The row in bold type is what is left of the gap between what the project *claims* and what it
*runs*, and it is the one the README still lists under "written and tested, not yet live" —
which is to your credit while it is true. Anchoring, which used to sit beside it here, is done
(A2). Closing the last one is worth more than any new feature.

---

## 2. Why not mainnet

Five reasons, in order of weight:

1. **A bug on mainnet costs real money, live, in front of judges.** On Sepolia the worst
   case is an awkward pause. The failure modes you have not hit yet are the ones that show
   up under demo conditions.
2. **It does not strengthen the security argument at all.** Every claim — confidential
   budget, enclave custody, non-discretionary signer, injection resistance — is identical on
   either chain. A judge who doubts the architecture will not be convinced by the chain id.
3. **52 references to `baseSepolia` / `84532` across 12 files.** Centralised in
   `shared/chain/usdc.ts` and `x402/protocol.ts`, so it is tractable, but it is an afternoon
   plus a re-audit, and an afternoon is expensive right now.
4. **New live dependencies**: mainnet RPC, mainnet gas, a funded facilitator, real USDC.
   Each is another thing that can be down at 3pm on demo day.
5. **The money that is already real is the interesting money.** You are spending genuine
   AIsa credits per search. "This call cost us $0.008 of a real API budget, and the
   confidential policy is what decided whether to make it" is a *better* line than
   "the USDC was mainnet".

**Say the testnet part out loud in the first minute.** Volunteering a limitation reads as
confidence; having it extracted under questioning reads as an oversight.

---

## 3. Track A — close the credibility gaps

### A1. Deploy the ROFL enclave — **the single highest-value item**

Right now the payer key is in `.keys/payers.json`. The claim *"no operator can extract it"*
is true of `RoflKeyStore` and false of what is running. That is the one place where a
sharp judge can say "so the demo doesn't do the thing the pitch is about", and they would
be right.

Everything needed is committed: `services/signer/rofl.yaml` (TDX, Sapphire Testnet),
`Dockerfile`, `compose.yaml`.

**Step-by-step: [`ROFL_RUNBOOK.md`](ROFL_RUNBOOK.md)** — ten sections, three verification
gates, and a failure table. Half a day, ~150 TEST ROSE.

Then **set `SIGNER_REQUIRE_ROFL=true`**. `openKeyStore` refuses to boot without an enclave,
which converts "we hope it's using the enclave" into "it cannot run without one." That
single line is the difference between a claim and a guarantee, and it is already written.

**Demo value:** you can show the signer refusing to start with the flag on and the socket
absent. A control you have watched fail is a control the audience believes.

### A2. Anchor the trace root on chain — **done**

`TraceAnchor` is live at `0x065d5e16160159cAB7D841818aBc92b4E85D5818` and a runtime path now
calls it. `serve.ts` builds a `TraceAnchorClient` when `TRACE_ANCHOR_ADDRESS` is set, and
`server.ts` anchors the root immediately after `builder.build()` and the save — in that order,
so a root on chain always has a file to be checked against. The outcome (`anchored`,
`already`, `skipped`, `failed`) is emitted on the SSE stream and logged; a failure to anchor
never fails the run, because the money has moved and the record exists either way.

Leaving `TRACE_ANCHOR_ADDRESS` unset is the documented opt-out, not a silent skip: traces stay
tamper-evident, they just carry no proof of *when*.

It turns "here is a hash chain you can verify" into "here is a hash chain, and this block
proves it existed in this exact form before I walked on stage." Cheap — 32 bytes.

### A3. Make the injection actually land

Today `qwen3.7-flash` **resists** `premium-feed`, so the demo's most vivid moment never
happens. Three options, and you can carry more than one:

| Option | Cost | Honesty |
| --- | --- | --- |
| Top up AIsa, use a frontier model | money + it may still resist | best, if it complies |
| Blank `AISA_INFERENCE_KEY` → scripted agent for that goal | free | fine, *if you say it* |
| Lead with `compliance-audit` instead | free | strongest already |

**Lead with `compliance-audit` regardless.** It is the better demo and always was: a
plausible price, an allowlisted payee, unremarkable prose, no injection anywhere — and it
is still refused. Nothing public could have refused it. That is the whole product in one
run, and it works today with the model you have.

Treat the injection as the follow-up, and report the result honestly either way. "This model
resisted; the architecture does not depend on it resisting" is a strong line.

### A4. Break the payment circularity — **done**

`VENDOR_AISA_PAYEE` is now a dedicated address, distinct from both the deployer wallet and the
relay, so the agent no longer pays the account that opened the goal. Keep that key — the funds
are meant to be swept back afterwards, which also means the honest line on stage is "a separate
payee", not "an unrelated counterparty". The obvious question is closed; the overstatement it
would invite is not worth reopening it.

---

## 4. Track B — make it unfailable on the day

This is what actually loses hackathon finals. None of it is glamorous.

- **Pre-flight script.** Extend `tools/e2e/preflight` to assert, in one command: all six
  services healthy, ETH balance above a floor, USDC balance above a floor, both RPC
  endpoints answering `eth_call`, AIsa reachable with both keys, vendor spend ceiling not
  already consumed, and a goal openable. Run it ten minutes before you present.
- **MetaMask's RPC is not your RPC.** `writeContract` broadcasts through MetaMask's own
  endpoint, so `VITE_RPC_URL` does not protect it — this is what broke `openGoal` earlier.
  Set MetaMask's Base Sepolia RPC to `https://base-sepolia-rpc.publicnode.com` on **every
  machine that will touch the demo**, and check it the morning of.
- **Open the goal before you present.** Goal opening is the slowest, most wallet-dependent
  step. Have a funded goal ready and a second in reserve.
- **Budget arithmetic.** At 0.30 budget, live search costs 0.01 a call — ~30 searches before
  the vault refuses. Do not burn the goal you need for `compliance-audit` on exploratory
  searches. Open a fresh goal for the adversarial run.
- **Record a full successful run beforehand.** If the venue wifi dies you still have the
  evidence. Nobody has ever been marked down for having a backup.
- **Rehearse the failure.** Someone will unplug something. Know what each service prints
  when its dependency is missing — you built good messages, so use them.

---

## 5. Loopholes, and how to fix each

Everything a hostile reviewer could reasonably raise. Being able to name these before they
do is worth more than closing half of them silently.

### Architectural

| # | Loophole | Severity | Fix |
| --- | --- | --- | --- |
| L1 | **Payer keys on disk**, not in an enclave. The core custody claim is unbacked in the running system. | **High** | A1 — deploy ROFL, set `SIGNER_REQUIRE_ROFL=true`. |
| L2 | **The orchestrator can inflate the amount.** It holds the relay key and calls `requestSpend(goalId, amount, payTo, resource)` — nothing forces `amount` to match the 402. The *model* cannot, but a compromised orchestrator can, up to `perCallCap` (6.00) to any allowlisted payee. `llm.ts` states this openly. | **High** | Bounded today by `perCallCap` × `callsRemaining` × the encrypted budget × the allowlist. **Real fix:** have the vendor sign its terms `(amount, resource, expiry)` and make `requestSpend` verify that signature — then the orchestrator cannot invent a number the vendor never quoted. This is the most valuable architectural improvement left, and worth *describing* even if you do not build it. |
| L3 | **`vendor-upstream` is vendor-attested.** Nothing proves the bytes delivered match what was paid for. | Medium | Already handled honestly: the step carries `attestedBy: "vendor"`, the verifier rejects it if it claims an on-chain attestation, and the CLI says so after `VALID`. Do not over-claim; the honesty *is* the answer. |
| L4 | **You run the facilitator**, so "outside our trust boundary" is aspirational. | Medium | Correct in the write-up: it is architecturally outside, operationally inside. A facilitator cannot forge an authorization — it can only decline to submit one — so the bound is real even when you run it. |
| L5 | ~~**Trace roots never anchored** — a trace could be edited before anyone sees it.~~ | ~~Medium~~ | **Fixed.** The orchestrator anchors the root after every completed run, behind `TRACE_ANCHOR_ADDRESS`. A2. |
| L6 | **Catalog is hardcoded**; no discovery. The agent is handed URLs. | Low | Expose a capability manifest from `vendor-aisa`. Frame honestly: the 402 *is* price discovery; finding the URL is a separate layer. |

### The AIsa integration

| # | Loophole | Severity | Fix |
| --- | --- | --- | --- |
| L7 | **The orchestrator holds a money-spending AIsa key.** An injected orchestrator can spend it on data APIs, and `PolicyVault` never sees a cent of it — the vault ledger stays clean while the balance drains. | **High** | Two scoped keys (done) + **per-key spending caps** at `console.aisa.one` (do this — it is the only control that bounds it, since nothing restricts a key by endpoint family). Keep the account balance near what the demo needs. |
| L8 | ~~**`SpendLedger` is in-memory.** Restart the vendor and the hourly ceiling resets to zero; a crash loop is unbounded spend.~~ | ~~Medium~~ | **Fixed.** Persisted to `.vendor-aisa/ledger.json`, window carried across restarts. Unreadable, corrupt, or future-dated ledgers start a fresh window rather than refusing to serve — the provider-side spending cap is the backstop that does not depend on this process. |
| L9 | **No balance endpoint at AIsa** — six candidates all 404. You cannot verify remaining spend programmatically. | Low | Sum `x-aisa-customer-cost-micros-usd` (already recorded) and reconcile against the dashboard manually. |
| L10 | **The key that leaked into a chat is still live.** | **High** | Revoke `initial token` at `console.aisa.one`. Replace with a named, capped key. Do this before the final regardless. |
| L11 | **The search query is an outward untrusted channel** — browser → orchestrator → vendor → paid API. Injection surface *and* cost vector. | Medium | Already: rejected-not-sanitised at both hops, 256-char cap, control characters refused, URL-encoded into `resource`, rate-limited, spend ceiling. Worth naming as a deliberately-defended surface rather than hoping nobody asks. |

### Operational

| # | Loophole | Severity | Fix |
| --- | --- | --- | --- |
| L12 | **Testnet USDC has no value**, so "real payment" is doing work in the sentence. | Medium | Volunteer it in the first minute, and pivot to what *is* real: the AIsa credits, the attestations, the settlement mechanics. |
| L13 | ~~**Circular payee** — the vendor pays your own wallet.~~ | ~~Low~~ | **Fixed.** A dedicated payee address, separate from the deployer and relay wallets. Still recoverable by you, so say "separate payee" rather than "third party". A4. |
| L14 | **No auth on the services by default** (`SERVICE_TOKEN` unset). Loopback-bound, so fine locally; fatal if anything is exposed. | Low | Leave as-is for a local demo. If anything is deployed, set `SERVICE_TOKEN` and `BIND_HOST` deliberately. |
| L15 | **`premium-feed` at 5.00 exceeds `MAX_BUDGET` 4.00**, so it can never be affordable — that path only ever shows a refusal. | Low | Deliberate, and documented in `App.tsx`. Mention it before someone finds it. |
| L16 | **MetaMask's RPC is a single point of failure** for every write. | Medium | Track B — set it manually, verify on the day. |

---

## 6. Track C — mainnet, if you insist

Not recommended for the final (§2). If you want it afterwards:

1. **Constants** — `USDC_BASE_SEPOLIA` → mainnet USDC (`0x833589f…2913` on Base), chain id
   84532 → 8453, `NETWORK_BASE_SEPOLIA` slug, `baseSepolia` → `base` in every viem client.
   Start at `shared/chain/usdc.ts` and `shared/x402/protocol.ts`; 12 files touch it.
2. **Inco Lightning on mainnet** — confirm availability and the fee. This may be the blocker;
   check before anything else.
3. **Funding** — real ETH for relay + facilitator gas, real USDC for the payer.
4. **Re-audit the trust model with real money at stake.** L2 stops being theoretical: an
   orchestrator that can request up to `perCallCap` is now able to lose real funds. Lower
   `perCallCap` hard, or build the vendor-signed-terms fix first.
5. **Do not demo it live the first time.** Run it privately, keep the traces, show those.

**Order matters: fix L2 before mainnet, not after.**

---

## 7. Sequence

| When | Do | Why |
| --- | --- | --- |
| **Now** | Revoke the leaked key (L10). Cap both keys (L7). | Minutes, and closes the two live risks. |
| **Day 1** | Deploy ROFL, set `SIGNER_REQUIRE_ROFL=true` (A1). | Biggest claim→reality gap. |
| ~~**Day 1**~~ | ~~Anchor trace roots (A2).~~ | **Done.** Completes the verifiability story. |
| **Day 2** | ~~Non-circular payee (A4).~~ Decide the injection story (A3). | Payee done; the injection story is still open. |
| **Day 2** | Pre-flight script, MetaMask RPC, spare goal, recorded run (Track B). | This is what saves the demo. |
| **Day 3** | Rehearse twice, including one deliberate failure. | — |
| **After** | Vendor-signed terms (L2). Then consider mainnet. | The real architectural win. |

If you only do three things: **ROFL (A1)**, **lead with `compliance-audit` (A3)**, and
**the pre-flight script (Track B)**.

---

## 8. The line to open with

> Everything you are about to see moves real value. The USDC is on Base Sepolia because
> we would rather not lose real money on stage — but the API calls cost real dollars, the
> encryption is real Inco Lightning, the enclave is a real TDX attestation, and the agent
> genuinely does not know what its budget is. The one thing we are proving is that when
> the agent is talked into overspending, it cannot.

Then run `compliance-audit` and let it bounce.
