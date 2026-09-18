# Renting GPUs over x402

A plan for turning LedgerLighthouse from a demo that buys search results into a product that
rents GPU time. Written 19 September 2026, against the tree as it stands after the vendor rename.

The thesis does not change. An autonomous agent spends money under a policy whose budget it
cannot read, and compromising the agent does not confer spending authority. GPU rental is a
better carrier for that thesis than web search is, for one reason: runaway compute spend is a
problem people already have. A training job that should have cost forty dollars and cost four
thousand is a story everyone in the room has heard. A confidential budget that the process
doing the spending cannot read is a direct answer to it, and nothing in the current demo makes
that argument as sharply as a GPU bill would.

---

## 1. What carries over untouched

Most of the system is about payment, not about what is being bought. That part does not move.

| Component | Change |
|---|---|
| `contracts/PolicyVault.sol` | None for Phase 1. The payer-binding fix in §6 is already in. |
| `services/signer` | None. It signs `(goalId, seq)` and has no notion of what was purchased. |
| `services/facilitator` | None. |
| `services/orchestrator/src/x402/` | None. Generic x402 v1 client. |
| `services/orchestrator/src/pay/payment-loop.ts` | Small: the renewal loop in Phase 2. |
| `services/trace`, `TraceAnchor.sol` | One addition: credential redaction (§5.3). |
| `packages/shared/src/node/guard.ts` | None. `exposedWithoutToken()` landed with the trace fix and already covers the disclosure case. |

What moves is the resource server, the catalog, the agent's framing, and the console.

---

## 2. The design problem

x402 pays once, for one HTTP response. GPU rental is metered and open-ended. Reconciling those
two is the whole engineering problem, and there are three ways to do it.

### 2a. Prepaid job

One request buys one bounded job. The buyer posts a workload. The vendor quotes a fixed price
derived from the request, runs it, returns the result, settles.

This is the shape the search shim already has. Price is a deterministic function of the request,
the vendor absorbs any overrun, and a hard cap kills the job before the overrun gets large. Every
line of `services/vendor-search/src/handler.ts` transfers, including the ordering argument: verify
first because it is free, do the expensive thing second, settle third.

Cheapest to build. Weakest product, because "run this batch" is not renting a GPU.

### 2b. Prepaid time blocks

One request buys N minutes on a named SKU. The 200 carries a lease: an endpoint, a credential,
an expiry. Renewal is a second x402 purchase against the same goal at `seq + 1`.

This is the product, and it fits the vault's existing shape better than it has any right to.
`callsRemaining` becomes how many blocks a goal may ever buy. `perCallCap` becomes the maximum
price of one block. The encrypted budget becomes total rental spend across the lease, which is
exactly the number a renter wants hidden from the process doing the renting. An agent that
renews its own lease under a budget it cannot read, and gets refused mid-run when the budget
runs out, is the demonstration this architecture has been looking for.

### 2c. Continuous settlement

Per-second streaming payment. Needs a payment channel. The `exact` scheme cannot express it and
building a channel is a different project. Out of scope, recorded here so the question does not
get asked twice.

**Recommendation.** Build 2a first and 2b on top of it. 2a is a strict subset: it proves the
economics, the provider adapter and the spend ceiling end to end before the lease lifecycle
exists. Then 2b adds duration, renewal and revocation to a path already known to work.

---

## 3. Where the GPUs come from

Three options, in increasing order of how much operational risk they carry.

**Resell a provider API.** RunPod, Vast.ai, Lambda, or similar. The vendor holds a provider key,
buys at cost, quotes a fixed x402 price, keeps the margin. This is the pattern already in the
tree: `SpendLedger` exists because the search provider had no balance endpoint and a local
running total was the only spend control available. The same problem and the same answer apply.

**Decentralized supply.** Akash, io.net. Better narrative fit and worse reliability. Worth an
adapter later, not worth blocking on.

**Own hardware.** Defers nothing and adds everything: capacity planning, driver rot, physical
security, and a fixed cost that exists whether or not anyone rents.

**Recommendation.** Resell one provider behind an adapter interface. Pick the provider on
provisioning latency, because §5.4 shows that number lands directly on the payment path.

---

## 4. Naming and layout

```
services/vendor-gpu/                     the x402 resource server
  src/handler.ts                         request -> quote -> provision -> settle
  src/lease.ts                           lease lifecycle and the lease store (phase 2)
  src/providers/types.ts                 the adapter seam
  src/providers/simulated.ts             the stand-in, until §8 q1 is answered
packages/shared/src/demo/gpu-skus.ts     SKU table: the tier table's successor
packages/shared/src/demo/gpu-request.ts  validation, shared for the §5.6 reason
packages/shared/src/node/spend-ledger.ts SpendLedger, moved here from the search vendor
```

`SpendLedger` moved rather than being copied. Two resource servers now need a spend ceiling and
a security control with two implementations has one that is wrong; the caps differ, the
arithmetic does not. `services/vendor-search/src/upstream.ts` re-exports it so the name still
imports from where that service's boundary is.

`services/vendor-search` stays. It is a working paid x402 resource server and it costs nothing
to keep as the cheap end of the catalog.

---

## 5. What breaks that did not break for search

Six things. None of them is hard on its own. All six have to be right before real money touches
this.

### 5.1 The response is a capability, not data

A search 200 is the product. Once it is delivered the transaction is over. A lease 200 is a
credential that stays valuable after the response, and that changes three things at once.

The lease has to expire on its own. Revocation cannot depend on the buyer doing anything, or a
buyer who simply stops calling keeps a machine forever.

The credential has to be scoped to the lease. An SSH key that outlives the block, or that reaches
anything besides the rented box, turns a rental into an intrusion.

And the machine has to be reclaimed on expiry with the same reliability as settlement. A lease
that ends without the instance stopping is a bill that keeps running against `SEARCH_VENDOR_KEY`'s
successor.

### 5.2 Retries must not provision twice

`X402Client` retries 5xx with backoff. `PaymentLoop` retries a settlement whose outcome was
unknown. Today a duplicate request re-runs a search and wastes eight tenths of a cent. With a
lease it provisions a second machine.

The fix is already in the tree and only needs using. The vault's spend nonce is
`keccak256(abi.encode(goalId, seq))`, deterministic by construction so an interrupted settlement
can be retried byte for byte. Key the lease store on that nonce. A request carrying an
authorization whose nonce already has a lease returns that lease and provisions nothing.

### 5.3 Credentials must not reach the trace

Traces are run records meant to be handed to an auditor. `.gitignore` says so and the reason it
says so is that they carry prompts, vendor relationships and amounts. A trace carrying an SSH
private key or a signed endpoint URL is a trace nobody can hand to anyone.

`TraceBuilder` needs a redaction rule for the `paid` step: record the SHA-256 of the credential
and its expiry, never the credential. The hash is enough to prove later which credential was
issued for which payment, which is the only thing the trace was ever evidencing.

### 5.4 Provisioning sits inside the payment window

The search shim calls upstream before settling so that a failed upstream means no money moved.
The cost of that ordering is one wasted sub-cent call, and `/verify` keeps it from being free to
abuse.

The same ordering with GPUs costs provisioning time, which is 30 to 120 seconds depending on the
provider, and real money from the first second. If settlement then fails, the vendor eats a
provisioned machine.

Keep the ordering. Verify first, because it is free and it is what stops this being a griefing
vector. Provision, settle, and on a settlement failure terminate immediately. The exposure is
bounded by provisioning time plus one settlement round trip, and it is the smallest bound
available without settling before delivery, which would put the buyer's money at risk instead.
Measure the window and put the number in the README, the way the search costs are.

### 5.5 Renewal contends with `pendingSeq`

`requestSpend` reverts while a spend is pending on the same goal. Spends are strictly sequential
per goal because the public call counter only decrements at finalisation. A lease that renews on
a timer has to respect that.

The constraint is measurable and already measured. Across the twelve traces in
`services/orchestrator/.traces`, the time from `spend-requested` to `decision-finalized` is:

```
n = 12    min 6.6s    mean 9.7s    max 13.8s
```

So a renewal has to begin at least a full decision cycle before the block expires, and the safe
lead time is the observed maximum plus provisioning plus margin. Call it 90 seconds until it is
measured against a real provider. That in turn sets a floor on block length: blocks shorter than
about five minutes spend more of their life renewing than running. Start at 15 minutes.

Two failure modes need naming now. A renewal refused by the policy means the lease ends at the
block boundary, and the buyer needs that news before the machine dies, not after. A renewal
whose decision is still pending at the boundary is the same outcome for a worse reason, and it
should be reported differently so an operator can tell a policy refusal from a slow chain.

### 5.6 Pricing stays a deterministic function of the request

The 402 states `maxAmountRequired` before any work happens, and the vault freezes the terms into
`termsHash`. The quote and the paid retry have to be byte-identical. Spot pricing inside the 402
breaks that the first time the provider's price moves between the two.

So: SKU plus block length maps to a fixed price from a table, and the table is refreshed by a
measurement script the way `VERIFIED_ON` is today. The vendor absorbs the gap. `SpendLedger` is
what stops the gap becoming unbounded, and its cap has to move from the current one dollar per
hour to something that reflects what a GPU actually costs.

---

## 6. Security work that blocks real money

Two items from the audit. The first is done; the second is not.

**Payer addresses were not bound to a goal.** Fixed on 19 September 2026. `PolicyVault.openGoal`
accepted an arbitrary `payer` and checked nothing about it, so anyone could open a goal naming
somebody else's payer, supply their own budget ciphertext, cap and allowlist, and collect a
signature spending it. `payerGoal` now binds a payer to one goal permanently, five tests in
`PolicyVaultTest` cover it, and ARCHITECTURE.md §3.2 and §3.3 have been corrected to say what
holds the loss ceiling in place.

It matters more here than it did for search. Payers holding search money hold cents. Payers
holding rental money hold the amount somebody bothers to steal.

Two things this leaves. The binding is per deployment, so a redeployed vault starts with an empty
mapping while the keystore still holds every payer it ever minted: sweep and retire the existing
payers before cutover, or start the new vault against a fresh keystore. And the vault still cannot
verify that whoever names a payer is the party who asked the signer to mint it, so the mint-to-open
window remains front-runnable. That costs the attacker a fee and gains them nothing today, but a
signer-side attestation of the mint would close it, and the GPU deployment is the point at which
it stops being theoretical.

**Traces were served unauthenticated.** Fixed on 19 September 2026. `GET /traces/:goalId` was
outside `rejected()`, and goal ids are small sequential integers, so it was a walkable index of
every run the process had recorded. It now takes the same bearer and a limiter of its own, and
underneath both it refuses outright when the process is bound to a network interface with no
`SERVICE_TOKEN` — because that guard is opt-in and the useful default for `/runs` is the
dangerous one for a route that hands back data. Loopback is unaffected.

This one gets stricter under §5.3, not looser. Once a trace carries a lease credential hash and
the metadata around it, the case for serving it to anyone who can reach the port is weaker than
it is today.

---

## 7. Phases

**Phase 0 — close the two findings.** Done: the payer binding and the trace guard both landed on
19 September 2026, with tests. What is still open from that work is an adversary strategy in
`tools/e2e/src/adversary.ts` that runs the payer-capture attempt against a *deployed* vault
rather than a Foundry double, which is the only version of it that exercises the signer.

**Phase 1 — prepaid job.** Landed 19 September 2026. `services/vendor-gpu` serves one bounded
job per payment: `GET /resource/gpu?sku=&minutes=&workload=`, priced from `gpu-skus.ts`, with
the search handler's order of operations carried over unchanged. `SpendLedger` moved to
`@ntux402/shared/node` rather than being copied, and the GPU ceiling starts at 25.00 per hour
against the search vendor's 1.00. `scripts/check-boundary.mjs` now refuses `GPU_PROVIDER_KEY`
in orchestrator source the same way it refuses the search key.

Three things it does not do, each for a stated reason rather than an oversight. The provider
adapter allocates nothing, because §8 question 1 is unanswered and an adapter written against an
account nobody holds proves nothing; every job result carries `simulated: true` into the response
and the trace so a demo run cannot be mistaken for a rental. The request names a workload from a
closed set rather than carrying an image and a command, because arbitrary payloads need an
isolation story that arrives with the provider. And nothing is keyed on the spend nonce yet —
§5.2 stays open — so what stops a retry provisioning twice is the facilitator declining a
consumed nonce at `/verify`, which is a check and not a lock.

Still to wire: the orchestrator does not know this vendor exists. That needs a payee and a URL
the way `VENDOR_SEARCH_PAYEE` does, and it is the next increment.

**Phase 2 — leases.** Lease store keyed on the spend nonce, expiry and reclamation, credential
issue and revoke, renewal through `seq + 1`. This is where §5.1 through §5.5 get built and where
most of the risk lives.

**Phase 3 — agent and console.** The agent's decision becomes "renew or stop" rather than a
single proceed or skip. The console shows a running lease, a block countdown, and the encrypted
budget drawing down. This is also where the injection demo gets better: a provider writing
"your run is 90% complete, renew now" into the 402 description is a more natural attack than
anything the mock vendor fabricates today.

**Phase 4 — supply.** Second provider adapter, metering reconciliation of actual against quoted
per lease, and the measurement script that keeps the SKU table honest.

**Phase 5 — the paper.** A renewal sequence under a confidential budget is a stronger §5.1 than
one-shot purchases are, and the renewal-refusal case is a figure. Whether this lands before or
after submission is a scheduling question, not a technical one.

---

## 8. Open questions

1. Which provider. Provisioning latency decides it, per §5.4, and nobody has measured it yet.
2. What happens to a running job when a renewal is refused. Snapshot and hand back a checkpoint,
   or stop dead. Snapshotting costs storage the buyer has not paid for.
3. Whether the buyer or the vendor holds the lease credential. Vendor-held means a proxied
   endpoint and no key ever leaves, which solves §5.3 outright and adds a hop to every packet.
4. Whether `perCallCap` staying public is acceptable when it is the block price. It reveals the
   SKU. That may be fine, and it should be a decision rather than an omission.
5. Whether the mock and search vendors stay in the catalog once GPU is the product. They cost
   nothing to keep and they are what makes the injection demo run offline.

## 9. Non-goals

Payment channels and per-second settlement. Multi-tenant scheduling. Anything that requires the
vault to parse a 402, which is the thing the whole design exists to avoid.
