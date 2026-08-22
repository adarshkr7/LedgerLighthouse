# Live search: replacing the mock vendor end to end

Turning the demo from *"the agent buys a fabricated ETH/USD quote from a mock server"* into
*"the viewer types a real query, the agent buys real search results from AIsa over x402, and
the confidential budget governs the spend."*

Companion to [`AISA_INTEGRATION.md`](AISA_INTEGRATION.md) (the trust argument) and
[`AISA_RUNBOOK.md`](AISA_RUNBOOK.md) (the general integration steps). This document covers
the dashboard and the backend path behind it.

Status: **proposed**. Nothing below is implemented.

---

## What the endpoints actually are

Confirmed against AIsa's API reference:

| Capability | Method + path | Notes |
| --- | --- | --- |
| Web search | `POST /apis/v1/tavily/search` | body `{ query, search_depth, max_results, topic, time_range, include_answer, include_usage, … }`; response `{ query, answer, results[{title,url,content,score}], usage, request_id, response_time }` |
| YouTube search | `GET /apis/v1/youtube/search` | required `engine=youtube` and `q`; optional `gl`, `hl`, `sp` |

Both are Bearer-authenticated against `https://api.aisa.one`.

### Two findings that shape the design

**1. Tavily is POST, and that does not matter.**
[`X402Client.fetchResource`](../services/orchestrator/src/x402/client.ts) is GET-only —
hardcoded `method: "GET"`, cache keyed on `cacheKey("GET", url)`. `AISA_INTEGRATION.md` §4
concluded from this that POST capabilities were out of scope. That conclusion was too
cautious and **this document supersedes it**: the shim is ours, so it can expose a GET route
to the payment loop and issue the POST upstream itself. GET in, POST out. The x402 client
never learns the difference and needs no change.

**2. Per-call cost comes back on every response, exactly.**
Tavily's body carries `usage` (`{credits: 1}` at basic, `2` at advanced) and a `request_id`.
More useful, the *headers* carry `x-aisa-customer-cost-micros-usd` — the true cost in
millionths of a dollar, which is the same unit as a USDC atomic amount.

This matters beyond pricing: it is a real spend tripwire. Six candidate balance endpoints
were probed and all six 404'd, so there is no account balance to poll — but summing this
header gives the shim exact cumulative spend without one. Both undocumented, so read
defensively and never require them.

---

## Step 1 — Price the call before you can know what it costs — **DONE**

x402 requires the resource server to state `maxAmountRequired` **in the 402**, before the
upstream call happens, so the shim cannot bill actual cost. It quotes a deterministic price
derived from the request and absorbs any difference.

Measured with [`scripts/aisa-measure-tiers.mjs`](../scripts/aisa-measure-tiers.mjs) on
2026-08-22, four calls across a depth × result-count grid:

| Tier | `search_depth` | `max_results` | Measured cost | Quoted | Latency |
| --- | --- | --- | --- | --- | --- |
| basic | `basic` | 5 | $0.008 (8000 atomic) | **0.01 USDC** | ~3.6 s |
| deep | `advanced` | 10 | $0.016 (16000 atomic) | **0.02 USDC** | ~9.8 s |

Three things the measurement settled:

- **Only `search_depth` moves the price.** `max_results` was varied 5 → 10 at both depths
  and changed nothing, so the tier is named for depth and `maxResults` is a quality knob,
  not a pricing input. It is also not guaranteed — a `basic` call asking for 10 returned 9.
- **Cost is reported exactly, in headers nobody documented.**
  `x-aisa-customer-cost-micros-usd` and `x-aisa-provider-cost-micros-usd` come back on every
  call. Micros USD and USDC atomic units are both millionths, so the header value *is* the
  atomic cost — no conversion anywhere.
- **`advanced` costs 2× and takes ~3× longer.** Ten seconds of upstream latency sits inside
  the payment flow, which Step 7 has to account for in the UI.

Margin is ~25%, chosen to land on 0.01 and 0.02 — round numbers displayed next to a budget
the viewer picked. Both sit far below the 6.00 per-call cap and inside the 0.20 demo budget,
so a viewer can run a dozen real searches and watch the encrypted balance draw down before
anything is refused. That is a *different* demonstration from the single over-budget bounce,
and a complementary one: the budget is a running total the agent cannot read.

Landed in [`aisa-tiers.ts`](../packages/shared/src/demo/aisa-tiers.ts) rather than
`catalog.ts` — same shared package and same barrel, so the one-definition property holds,
but the goal catalog stays about goals.

---

## Step 2 — The query is a new untrusted input, and a new cost vector

Today the only attacker-controlled text is the vendor's `description`, and the whole
architecture is built around that one channel. A viewer-supplied query is a **second**
channel, running the other direction: browser → orchestrator → shim → AIsa. Treat it as
hostile at every hop.

- **Length cap and character class** at the orchestrator's `POST /runs` boundary. Reject,
  do not sanitise — the repo's existing posture for the 402 parser.
- **URL-encode it into the resource path.** The query ends up in the x402 `resource` field,
  which [`requireResource`](../packages/shared/src/x402/terms.ts) demands be URL-shaped, and
  which the vault hashes into `termsHash`. A raw space breaks parsing; a crafted string
  could otherwise smuggle path segments.
- **Rate-limit per caller**, and keep the hard upstream call ceiling from
  `AISA_RUNBOOK.md` Step 6. A free-text box wired to a paid API is a way to spend $101 fast.
- **Never let the query select the tier's price.** The tier is a named choice; the price
  comes from the catalog table, not from anything the browser sends.

**Gate:** a test that a 5,000-character query, a query with a `/`, and a query with a
newline are each rejected at `/runs` with no upstream call made.

---

## Step 3 — Build the vendor shim — **DONE**

Built as `services/vendor-aisa`, 30 tests. One thing changed from the plan below, and it
matters: **the facilitator's `/verify` runs before the upstream call.**

The plan had local sanity checks and then the upstream call, which leaves a griefing hole.
A well-formed authorization that will fail at settlement — an already-consumed nonce, an
unfunded payer — passes every check we can do locally, so we would pay AIsa for a search
before discovering it. Looped, that drains the vendor's balance for free, and every one of
those calls is a real charge. `/verify` is in the x402 protocol precisely so a resource
server can ask "would this pay?" before doing the work.

The resulting order runs cheapest-first, each costly step guarded by a free one:

| # | Step | Cost |
| --- | --- | --- |
| 1 | shape, tier and query validation | free |
| 2 | spend ceiling | free |
| 3 | local payload sanity (payee, amount, network) | free |
| 4 | facilitator `/verify` | free, no money moves |
| 5 | upstream AIsa call | **costs us** |
| 6 | facilitator `/settle` | moves the buyer's USDC |

Also landed alongside it, because the shim should not run without them:

- **`check-boundary.mjs` extended** to cover `@ntux402/vendor-aisa` *and* the literal string
  `AISA_VENDOR_KEY` in orchestrator source. A key needs no import to leak.
- **`SpendLedger`** — an hourly ceiling denominated in USDC atomic units, which are also
  micros USD. A call whose cost went unreported counts at the quoted price, so a missing
  header is not the cheapest way past the ceiling.

### Original plan

New package `services/vendor-aisa`, modeled on [`mock-api/src/`](../mock-api/src/):

```
GET /resource/aisa/search?q=<urlencoded>&tier=basic
  no X-PAYMENT -> 402 + x402 terms priced from the tier table
  X-PAYMENT    -> decode + validate
               -> POST https://api.aisa.one/apis/v1/tavily/search
                  { query, search_depth, max_results, include_usage: true }
               -> settle via the facilitator
               -> 200 + { results, answer, usage, request_id }
```

Upstream **before** settlement. If the upstream call fails after settlement, money has moved
with no data, and the only channel back through `X402Client` is a second 402 — which
[`payment-loop.ts`](../services/orchestrator/src/pay/payment-loop.ts) renders as *"the
resource server refused the payment,"* false in exactly the case where precision matters.
Fetching first fails closed: 502, no settlement, one wasted sub-cent call.

`AISA_VENDOR_KEY` lives here and nowhere else.

**Gate:** `GET /resource/aisa/search?q=test` returns a 402 that
[`parsePaymentRequired`](../packages/shared/src/x402/terms.ts) accepts.

---

## Step 4 — Decide what the cache does

[`X402Client`](../services/orchestrator/src/x402/client.ts) caches 200s under
`cacheKey("GET", url)`. Two identical searches means the second is served from cache,
`fromCache: true`, no payment, no upstream call.

For a *real-time* search demo that is probably wrong twice over: the viewer sees no payment
happen, and the results may be stale. But paying twice for a byte-identical answer is also
wrong. Pick deliberately:

- **Recommended:** add a run nonce to the resource URL so every run is a distinct resource.
  Real-time semantics preserved, every run pays, cache still protects against the retry-after-
  a-blip case it was actually built for.
- Alternative: leave caching on and surface `fromCache` prominently in the UI.

**Gate:** two consecutive identical searches both show a settlement, or the UI states plainly
that the second was cached.

---

## Step 5 — Catalog and routing — **DONE**

Two live entries — `aisa-search-basic` (0.01) and `aisa-search-deep` (0.02) — with prices
read from `SEARCH_TIERS` rather than restated, so displayed and charged cannot drift. All
four synthetic goals kept.

Three decisions worth recording:

- **`payTo` is now optional on `DemoGoal`.** The live vendor's payee is an address the
  *operator* controls and can sweep (`VENDOR_AISA_PAYEE`), so a package that compiles into a
  browser bundle cannot know it. It arrives from the orchestrator's `/config` as
  `vendorAisaPayee`, and the console must union it with `DEMO_PAYEES` before opening a goal
  — otherwise every live spend reverts `PayeeNotAllowlisted`, which is correct and baffling.
- **`isMockGoal` is the routing predicate, never the key's name.** A prefix rule like
  `mode.startsWith("aisa-")` sends a renamed goal to the wrong vendor, and that failure is a
  200 carrying the wrong product at the right price — the exact bug the shared catalog
  exists to prevent. `mock-api` now 404s upstream goals instead of serving a fixture for
  them.
- **Live search is opt-in, gated on the payee rather than the URL.** Unset, `/config`
  reports it unavailable and `POST /runs` answers 503 up front rather than failing as a
  fetch error twenty seconds in with a goal already debited.

Covered by `services/orchestrator/src/server.test.ts` (8 tests), including that a query
containing `a b&tier=deep#frag/../../etc` cannot break out of the query string or override
the tier.

One thing the guard taught us: `check-boundary.mjs` failed on a *comment* naming the vendor
key. The check stayed blunt and the prose was reworded — for a guard like this a false
positive costs a sentence and a false negative costs the key.

### Original plan

- Extend `DemoGoal` with `upstream?: { vendor: "mock" | "aisa"; path; tier }`.
- Add the live-search goals (`aisa-search-basic`, `aisa-search-deep`).
- **Keep all four synthetic goals.** A real search that happens to be affordable proves
  nothing; `compliance-audit` is still the only case where a plausible price, an allowlisted
  payee and unremarkable prose are refused by the encrypted budget alone. Its `?price=`
  override must keep tracking the operator's chosen budget, which a real vendor's published
  price cannot do. Live search *adds* a case; it does not replace the argument.
- [`server.ts:259`](../services/orchestrator/src/server.ts) selects the base URL from
  `upstream.vendor` instead of always `ctx.mockApiUrl`, and appends the encoded query.
- Add the vendor payee to `DEMO_PAYEES` — and make it an address you control and can sweep,
  since real USDC now lands there. The current four are placeholders (`0x1111…`).
- [`scripts/dev.mjs`](../scripts/dev.mjs) gains the `vendor-aisa` service.

**Gate:** the console lists the live-search goals and the price it shows equals the price the
402 demands.

---

## Step 6 — Backend surface for the dashboard — **DONE**

`POST /runs` takes `query`; `/config` reports `vendorAisaUrl` and `vendorAisaPayee` (that
part landed in Step 5).

The query validator moved to `@ntux402/shared` as `search-query.ts`, because both the
orchestrator and the vendor run it and the boundary check forbids either importing the
other — a shared module is the only place one definition can sit. The two passes are not
redundant: the orchestrator's is the courteous one (fails before any chain write, gives the
browser a usable message), the vendor's is load-bearing (its caller is the component this
architecture assumes is compromised). A query sent for a mock goal is also a 400 — a
control that silently does nothing is worse than one that says no.

### Original plan

- **`POST /runs`** accepts `query` and `tier` alongside `goalId` and `mode`, validated per
  Step 2, and threaded into the run context.
- **`GET /config`** currently exposes `mockApiUrl`, which the UI renders. Add `vendorUrl` and
  keep `mockApiUrl` — both vendors run, so one field cannot describe both. Also expose
  whether the AIsa vendor is configured at all, so the UI can disable live search rather than
  offering a button that 500s.

**Gate:** `/config` reports both vendors, and `/runs` rejects a malformed query before any
chain write.

---

## Step 7 — The dashboard — **DONE**

A query box on upstream goals only, and a `Delivered` panel rendering the real results.

- **The payee union landed.** `openGoal` now allowlists `DEMO_PAYEES` *plus*
  `config.vendorAisaPayee`. This was the live wire from Step 5: omitting it does not fail
  at open time, it fails much later as `PayeeNotAllowlisted` — looking for all the world
  like the confidential budget refusing a spend it never saw.
- **`safeHref` lives in `@ntux402/shared`, not in the component.** It filters result URLs to
  `http(s)`, and a `javascript:` href in a search result would be one click from running
  script in the console's origin next to a connected wallet. That is a security control, and
  `apps/web` has no test runner — so it sits where it can have eight tests instead.
  `asSearchPayload` went with it, and returns nothing for the mock vendor's fabricated price
  tick, so a fixture can never render as purchased data.
- **Third-party text is quoted, never absorbed.** Results are React children (never
  `dangerouslySetInnerHTML`), links carry `noopener noreferrer nofollow`, snippets are
  clamped to three lines so a vendor cannot flood the panel to push the settlement details
  out of view, and the footer says plainly that none of it was written by the console.
- **Costs shown side by side.** Charged vs the vendor's actual cost, from
  `x-aisa-customer-cost-micros-usd`. It is the only place a viewer can see that the 402's
  price was a quote rather than a passthrough.

Verified in the browser: all six goals list at the right prices, and an upstream goal with
no vendor configured renders the disabled state rather than a button that fails. The
*enabled* branch is unverified visually — it needs `VENDOR_AISA_PAYEE` set and the vendor
service running.

### Original plan

The payload already reaches the browser. [`server.ts`](../services/orchestrator/src/server.ts)
emits the whole `PaymentResult` on the `result` channel, and the `paid` variant carries
`data` — the web-side `RunResult` type in [`run.ts`](../apps/web/src/lib/run.ts) simply does
not declare it. **So rendering real results is a type addition plus a component, not a
protocol change.** That is the cheapest part of this whole plan.

- **`run.ts`** — add `data?: unknown` to the `paid` variant; add `query`/`tier` to
  `streamRun`'s POST body.
- **[`GoalPicker.tsx`](../apps/web/src/dashboard/GoalPicker.tsx)** is already "a search field
  that opens the catalog." Extend it so a query that matches no catalog entry offers *"search
  the web for …"* as a live-search run. The metaphor is already right; it just currently only
  searches four canned rows.
- **New results panel** — render `results[]` as title / url / snippet / score, plus `answer`
  when present. This is the first time the demo shows something a viewer would actually
  want, rather than a hardcoded price tick.
- **Usage strip** — `usage` and `request_id` beside the settlement tx. The claim becomes
  legible: *this much USDC moved on chain, and this is what the vendor says it cost.*
- Attacker-text discipline still applies. Search results are third-party text rendered in
  our UI: escape everything, render URLs as text or `rel="noopener noreferrer"` links, and
  never interpolate result content into anything that reads as the console's own voice —
  the treatment `attributeVendorText` already applies to vendor refusal strings.

**Gate:** a real query returns real results in the panel, with a real settlement tx, and a
hostile result title cannot break the layout or impersonate console chrome.

---

## Step 8 — Trace — **DONE**

A `vendor-upstream` step carrying capability, tier, upstream request id, latency, and both
amounts — what was charged and what the vendor says it paid.

The design problem was not what to record but how to record it *without lending it the
credibility of everything around it*. Every other claim in a trace is re-derivable offline
or re-checkable against Base Sepolia. This one is a third party's account of an HTTP call no
RPC can reach, sitting in a file whose entire purpose is to be verifiable.

Four things keep the line visible:

- **`VENDOR_ATTESTED_STEPS`** is data, not a comment, so adding a step type forces a
  decision about which side of the line it falls on.
- **The verifier actively rejects** a `vendor-upstream` step carrying a `StepAttestation` —
  even one whose hash is valid. A forged claim of chain-verifiability is an error, not a
  warning. Tested by constructing exactly that trace.
- **`attestedBy: "vendor"`** is written into the step's outputs, so it is legible in the raw
  JSON without knowing the type system.
- **The CLI says it out loud** after `VALID`, because that word is otherwise read as
  covering the whole file.

What the step *does* get is tamper-evidence: it hashes into the chain like anything else, so
the vendor's reported cost cannot be edited afterwards. Tested.

Amounts stay strings end to end — a number in `costAtomic` would mean an atomic value had
been through a float on its way into a hash. `vendorUpstreamOf` rejects anything that is not
plain digits. And when reported cost exceeds the quote, the orchestrator logs it: the shim
absorbs the loss, but it means the tier table is stale.

No key material and no raw upstream headers are recorded — only the fields named above.

### Original plan

Add the `vendor-upstream` step: capability, tier, upstream status, `request_id`, the `usage`
object, and quoted-price vs reported-cost.

Never record the API key or raw upstream headers. Record the step as **vendor-attested, not
chain-verified** — the standalone verifier proves on-chain facts from a trace file and a
public RPC, and an upstream HTTP call is not one of those. Do not let the addition imply the
verifier checked it.

**Gate:** a completed trace shows the upstream step, contains no key material, and the
verifier still passes.

---

## Order and effort

| Step | Work | Rough |
| --- | --- | --- |
| 1 | Tier pricing, measured | 1h |
| 2 | Query validation | 1h |
| 3 | Vendor shim | half a day |
| 4 | Cache decision | 30m |
| 5 | Catalog + routing | 2h |
| 6 | `/runs` + `/config` | 1h |
| 7 | Dashboard | half a day |
| 8 | Trace | 1h |

Steps 1–2 gate the rest. Step 7 is independent of 8.

## What this does not do

- **Does not retire `mock-api`.** Step 5.
- **Does not put `AISA_VENDOR_KEY` in the orchestrator.** The boundary check from
  `AISA_RUNBOOK.md` Step 9 must land before the shim runs.
- **Does not change `X402Client`.** GET in, POST out is the whole trick.
- **Does not let the browser choose a price.** Tier names in, catalog prices out.
