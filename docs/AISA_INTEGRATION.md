# Integrating AIsa

A plan for consuming [AIsa](https://aisa.one/docs/llms.txt) — its model gateway and its
priced data APIs — from LedgerLighthouse without weakening the invariant the project
exists to demonstrate.

Status: **proposed**. Nothing below is implemented.

---

## 1. What AIsa actually is

Read against the docs index, three separable things:

| Surface | Shape | Relevance here |
| --- | --- | --- |
| **Model gateway** | `POST /v1/chat/completions` (95 models), `POST /v1/messages` (85 models, Anthropic-compatible), `POST /v1/responses`. 108 models across OpenAI, Anthropic, Google, xAI, DeepSeek, Alibaba, Moonshot and others. | A drop-in alternative source for `services/orchestrator/src/agent/llm.ts` |
| **Priced data APIs** | `GET /apis/v1/<family>/<route>`, fixed per-call charge published on each API page (their own example: `/apis/v1/twitter/user/last_tweets` at `$0.0036`). Financial, search, scholar, twitter, prediction markets. | A **real vendor** for the payment loop to buy from |
| **Machine-payments guidance** | Prose. Budget policy, confirmation thresholds, audit retention — described as controls the integrator must build. | Positioning, not code. See §6. |

Base URLs: `https://api.aisa.one/v1` for models, `https://api.aisa.one/apis/v1` for data.
Auth is `Authorization: Bearer $AISA_API_KEY` throughout, billed against a prepaid balance.

### The fact that determines the architecture

**AIsa does not speak x402.** Their machine-payments and autonomous-purchasing pages name
no payment protocol, no HTTP 402, no headers, no settlement rail; that page states plainly
that a wallet existing "does not imply that every AIsa capability is available through an
autonomous payment protocol." Billing is a bearer key drawing down a prepaid balance.

So AIsa cannot be pointed at as an x402 resource server. Anything the payment loop buys
from AIsa has to sit behind a 402-speaking shim we run. That is §4.

---

## 2. The security constraint, first

An AIsa API key is a bearer credential that spends a prepaid balance across *every*
capability on the account — inference, financial data, Twitter writes.

The orchestrator already holds `LLM_API_KEY` today, and that is an accepted exposure: an
injected orchestrator can burn Anthropic tokens and nothing else. An AIsa key is not
equivalent. The same string that buys inference also buys data calls and authenticated
writes, which means a single `AISA_API_KEY` in the orchestrator hands the compromised
component a spending path that never touches `PolicyVault`. The vault ledger would stay
clean while the AIsa balance drained — the exact failure this project was built to rule
out, re-entering through a side door.

Three rules follow, and everything in §3–§5 is built to satisfy them:

1. **Two keys, never one.** `AISA_INFERENCE_KEY` for the orchestrator, `AISA_VENDOR_KEY`
   for the vendor shim. Different processes, different env vars, neither readable by the
   other.
2. **The vendor key never enters the orchestrator's environment or import graph.**
   Enforced in CI, the same way the signer boundary already is.
3. **State the residual honestly.** The inference key can still be spent on inference by
   an injected orchestrator. That is true of the Anthropic key today; it is a bounded,
   documented exposure, not a guarantee we claim to have. Use the register
   `agent/llm.ts` already uses for exactly this kind of admission.

**Phase 0 must confirm whether AIsa supports per-key capability scoping.** If it does,
rule 1 becomes a real control. If it does not, both keys draw on one balance and rule 1 is
only process isolation — say so in the docs rather than implying more.

---

## 3. W1 — AIsa as a model provider

**Effort: ~half a day. Low risk. Good demo value.**

`LlmAgent` constructs `new Anthropic({ apiKey })`. AIsa serves an Anthropic-compatible
`POST /v1/messages`, so the provider swap is a `baseURL`:

```ts
new Anthropic({ apiKey, baseURL: "https://api.aisa.one/v1" })
```

Changes:

- [`agent/llm.ts`](../services/orchestrator/src/agent/llm.ts) — accept an optional
  `baseURL` in `LlmAgentOptions`, pass it to the client.
- [`agent/factory.ts`](../services/orchestrator/src/agent/factory.ts) — thread `baseURL`
  through `AgentFactoryOptions`.
- [`serve.ts:88`](../services/orchestrator/src/serve.ts) and `main.ts` — read
  `LLM_BASE_URL` (blank = direct Anthropic, the default).
- `.env.example` — `LLM_BASE_URL`, alongside the existing `LLM_API_KEY` / `LLM_MODEL`.

### The catch: capability degradation

The current request uses four Anthropic-specific features a gateway shim is unlikely to
carry: `thinking: { type: "adaptive", display: "summarized" }`, `output_config.effort`,
`output_config.format.type: "json_schema"`, and `stop_reason === "refusal"` with
`stop_details`. AIsa's models page documents no structured-output or JSON-schema support
at all.

So `LlmAgent` needs a **compat mode** that drops `output_config` and `thinking`, asks for
the JSON object in the system prompt instead, and tolerates a fenced code-block wrapper
when parsing.

One sharp edge to get right: `parseDecision` returning `undefined` currently resolves to
`proceed: false`. Under a gateway that returns prose, that turns the whole demo into "the
agent declines everything" — silently, and looking like a policy result. A compat-mode
parse failure must emit a distinct, visible signal, not fall through to a refusal that
reads like a decision.

Also note that `thinking` is what feeds the "model's own reasoning (summarized)" section
`ModelInput.tsx` renders, and `llm.ts` calls that summary "the demo's most valuable
artifact." Losing it on the AIsa path is a real cost.

**Therefore: keep direct Anthropic as the default. AIsa is an added provider, not a
replacement.**

### What it buys

One key, models from four or five different labs. The injection can be run against Opus, a
GPT, DeepSeek-R1 and Kimi-K2-thinking, and the claim upgrades from *"a frontier model was
convinced"* to *"every model tested was convinced, and the vault refused all of them."*
That is a materially stronger version of the argument the demo already makes.

Model is currently a process-level env var (`LLM_MODEL`), read once at serve time —
`ModelInput.tsx` is a display panel, not a picker. Running four models means four restarts
unless per-run model selection is added to the `POST /runs` body and threaded through
`server.ts`'s run context. Small, and worth doing if the multi-model run makes the
submission.

---

## 4. W2 — AIsa as a real x402-priced vendor

**Effort: ~1–2 days. This is the substantive workstream.**

Today the only vendor is `mock-api`, and every endpoint returns the same fabricated
`ETH/USD 3421.55`. A shim in front of AIsa makes the agent buy *real data from a real
priced API* while the confidential policy governs the spend — without touching the
protocol, the vault, or the signer.

### Shape

New workspace package `services/vendor-aisa`, modeled on
[`mock-api/src/`](../mock-api/src/)`{handler,server,gateway}.ts`:

```
GET /resource/aisa/<capability>
  no X-PAYMENT   -> 402 + x402 terms (price from the shared catalog)
  X-PAYMENT      -> decode, validate
                 -> call upstream AIsa with AISA_VENDOR_KEY
                 -> settle via the existing facilitator
                 -> 200 + real upstream payload + X-PAYMENT-RESPONSE
```

### Upstream before settlement — a deliberate choice

The obvious order is settle-then-fetch. Reject it. If the upstream call fails *after*
settlement, USDC has moved and there is no data, and the only way to report that back
through `X402Client` is a second 402 — which
[`payment-loop.ts`](../services/orchestrator/src/pay/payment-loop.ts) renders as *"the
resource server refused the payment,"* a statement that would be false in the one case
where precision matters most.

Fetching upstream first fails closed: no upstream data, no settlement, no money moved, and
a 502 that `describeFailure` reports honestly as `HTTP 502`. The cost is one wasted AIsa
call (fractions of a cent) whenever settlement subsequently fails. No data is given away —
the payload is still withheld unless settlement succeeds.

### GET-only, and why that scopes the work

[`X402Client.fetchResource`](../services/orchestrator/src/x402/client.ts) hardcodes
`method: "GET"` and keys its cache on `cacheKey("GET", url)`. Choose GET-shaped AIsa
capabilities — `GET /apis/v1/financial/prices` (`ticker`, `interval`, `start_date`,
`end_date`), YouTube/Tavily search, scholar search — and **the payment loop, the client,
the cache and the trace need no changes at all.**

Wrapping `POST /v1/chat/completions` would mean changing the client's method, its cache
key, and its request-body handling. Out of scope for v1.

### Catalog

[`packages/shared/src/demo/catalog.ts`](../packages/shared/src/demo/catalog.ts) is the
single definition the vendor, the orchestrator and the console all read, so displayed price
cannot drift from charged price. Extend it, don't fork it:

- Add an optional `upstream` field to `DemoGoal`:
  `{ vendor: "mock" | "aisa"; path: string; params?: Record<string, string> }`.
- Add `aisa-prices` — real equity or crypto price history, honest pricing, cheap enough to
  settle inside the 0.20 budget. This is the *honest real* case.
- Optionally add `aisa-premium` — the same upstream capability at a hostile markup with the
  existing `INJECTION_TEXT` attached, showing the attack is identical against a real
  backend.
- **Keep all four synthetic entries.** `compliance-audit` in particular cannot be replaced:
  its `?price=` override exists so its price tracks whatever budget the operator chose at
  run time, and a real vendor's published price cannot do that. That entry is the one
  carrying the confidentiality argument.

Routing: [`server.ts:259`](../services/orchestrator/src/server.ts) currently builds
`${ctx.mockApiUrl}/resource/${ctx.mode}` unconditionally. It needs to select a base URL
from the goal's `upstream.vendor`.

Payees: the four existing payees are placeholder addresses (`0x1111…`). Real USDC paid to
an AIsa-backed vendor should land on an address the team controls and can sweep. Add it to
`DEMO_PAYEES` so goal opening allowlists it.

Pricing: vendor price = AIsa's published per-call price + margin, pinned in the catalog as
USDC atomic units with a `verifiedOn` date. A silent upstream price change otherwise means
selling below cost — trivial at these amounts, but the catalog's whole doctrine is that
prices are stated in one place and checkable.

### Testing

Mirror [`mock-api/src/handler.test.ts`](../mock-api/src/handler.test.ts). The upstream call
must be injectable (`fetchImpl`, exactly as `HttpFacilitatorGateway` already does) so the
suite never reaches the network and never spends a cent. Cover: 402 shape, settlement
success, settlement failure, and upstream failure producing 502-with-no-settlement.

### Wiring

- [`scripts/dev.mjs`](../scripts/dev.mjs) — add
  `{ name: "vendor-aisa", filter: "@ntux402/vendor-aisa", script: "start" }`.
- `.env.example` — `AISA_VENDOR_KEY`, `AISA_API_BASE_URL`, `VENDOR_AISA_PORT`, each with
  the "which component may hold this" note the file already applies to the four keys.
- `pnpm-workspace.yaml` already globs `services/*`. No change.

---

## 5. W3/W4 — Boundary enforcement and the trace

**Effort: ~half a day, and W3 is not optional.**

### W3 — CI

[`scripts/check-boundary.mjs`](../scripts/check-boundary.mjs) already proves the
orchestrator cannot reach the signer, by scanning import specifiers and `package.json`
deps. Extend the same file:

- The orchestrator must not import `@ntux402/vendor-aisa` or resolve into
  `services/vendor-aisa/`.
- The orchestrator source must not reference `AISA_VENDOR_KEY` by name.

~20 lines, reusing `resolvesIntoSigner`'s shape. `pnpm verify` then covers it, and the
pre-push hook does too.

### W4 — Trace

The trace is the evidence artifact, and a real upstream call adds facts an auditor wants:
the capability invoked, upstream HTTP status, upstream request id if AIsa returns one, and
published-price vs charged-price. Add a `vendor-upstream` step to the chain.

Two constraints:

- **No bearer tokens, no raw upstream headers in the trace.** AIsa's own guidance says
  never store API keys or bearer tokens in an audit record, which matches this repo's
  instincts anyway.
- **Do not overclaim verifiability.** The standalone verifier proves on-chain facts from a
  trace file and a public RPC. An upstream HTTP call is not one of those. Record it as
  vendor-attested, distinct from the chain-verified steps, or the verifier starts implying
  a guarantee it cannot check.

---

## 6. W5 — Positioning

AIsa's machine-payments page defines the controls an agent needs — per-request limit,
per-task limit, time-based limits, confirmation threshold, audit retention — and leaves
them to the integrator to build. LedgerLighthouse implements that list with an encrypted
on-chain budget, an enclave-held payer key and a hash-chained trace.

That is a factual, unhyped framing worth one short section in `README.md` and
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md): *AIsa supplies the models and the priced
capabilities; the spending authority its docs assign to the caller is what this project
provides.*

---

## 7. Sequence

| Phase | Work | Gate |
| --- | --- | --- |
| **0** | Get a key. `curl` `POST /v1/messages` with a compat body; `curl` `GET /apis/v1/financial/prices`; read the per-call price off the API page; ask whether per-key scoping exists. | Everything below depends on these four answers. Do not skip. |
| **1** | W1 — provider swap, compat mode, multi-model run | Compat parse failure is visible, not a silent decline |
| **2** | W2 — vendor shim, catalog, routing, tests | `pnpm verify` green; no network in tests |
| **3** | W3 + W4 — boundary check, env ledger, trace fields | CI fails if the orchestrator touches the vendor |
| **4** | W5 — docs | — |

Land or stash the current working-tree changes in `services/signer` and
`services/orchestrator/src/pay` before starting, so the boundary and test edits land clean.

---

## 8. What this plan deliberately does not do

- **Does not route the default demo through AIsa.** The summarized-thinking artifact is the
  demo's most valuable output and a gateway probably cannot carry it.
- **Does not put a data-capable key in the orchestrator.** §2.
- **Does not implement AIsa's "autonomous purchasing" flow.** It is governance prose with
  no protocol behind it, and this project already has a stronger answer to the same
  question.
- **Does not retire `mock-api`.** The overcharge case needs a price that tracks the
  operator's chosen budget; a real vendor's published price cannot.
- **Does not wrap POST-shaped capabilities.** That is a change to the x402 client and its
  cache key, for no additional argument.
