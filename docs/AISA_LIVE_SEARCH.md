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

**2. `usage` and `request_id` come back for free.**
Tavily's response carries a `usage` object and a `request_id`, and `include_usage: true`
asks for the former explicitly. That is exactly the per-call cost evidence the trace wants,
and it means "usage via AIsa" needs no separate billing endpoint — which is fortunate,
because no balance endpoint is documented.

---

## Step 1 — Price the call before you can know what it costs

Do this first, because it constrains everything after it.

x402 requires the resource server to state `maxAmountRequired` **in the 402**, before the
upstream call happens. But Tavily's cost varies with `search_depth` and `max_results`. The
shim therefore cannot bill actual cost — it must quote a deterministic price derived from
the request parameters alone.

Pin a small tier table in the shared catalog:

| Tier | `search_depth` | `max_results` | Quoted USDC |
| --- | --- | --- | --- |
| basic | `basic` | 5 | to measure |
| deep | `advanced` | 10 | to measure |

Measure real cost per tier with the probe, then quote that plus margin. When actual exceeds
quoted, the shim absorbs it — which is correct behaviour for a fixed-price offer, and is
why the tiers must be coarse rather than letting the caller dial arbitrary parameters.

**Gate:** a tier table with measured numbers and a `verifiedOn` date, in
[`catalog.ts`](../packages/shared/src/demo/catalog.ts) — the one place vendor, orchestrator
and console all read, so displayed price cannot drift from charged price.

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

## Step 3 — Build the vendor shim

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

## Step 5 — Catalog and routing

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

## Step 6 — Backend surface for the dashboard

- **`POST /runs`** accepts `query` and `tier` alongside `goalId` and `mode`, validated per
  Step 2, and threaded into the run context.
- **`GET /config`** currently exposes `mockApiUrl`, which the UI renders. Add `vendorUrl` and
  keep `mockApiUrl` — both vendors run, so one field cannot describe both. Also expose
  whether the AIsa vendor is configured at all, so the UI can disable live search rather than
  offering a button that 500s.

**Gate:** `/config` reports both vendors, and `/runs` rejects a malformed query before any
chain write.

---

## Step 7 — The dashboard

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

## Step 8 — Trace

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
