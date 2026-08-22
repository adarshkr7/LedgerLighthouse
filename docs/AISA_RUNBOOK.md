# AIsa integration — step-by-step runbook

The executable companion to [`AISA_INTEGRATION.md`](AISA_INTEGRATION.md), which carries the
*why*: the trust argument, the trade-offs, and the things this integration deliberately
does not do. Read §2 of that document before Step 2 here.

Every step below has a **gate** — the observable fact that says the step is done. Do not
carry an unmet gate into the next step.

---

## Budget reality check

You have **$101**. Expected burn for the whole integration, including the demo:

| Activity | Calls | Est. cost |
| --- | --- | --- |
| Step 1 probes | ~10 | < $0.50 |
| Multi-model injection matrix (4 models × 4 goals × 3 repeats) | ~48 inference | < $1.00 |
| Vendor smoke tests (tests themselves use an injected `fetch` and cost nothing) | ~50 data | ~$0.20 |
| Demo-day runs | ~20 | ~$0.50 |
| **Total** | | **under $5** |

You will not run out of credits. That is the point worth internalising: the risk attached
to this key is not the bill, it is that **something other than you spends it**. $101 is a
meaningful balance for an injected orchestrator to drain, and draining it would never
appear in `PolicyVault`'s ledger. Steps 2 and 9 exist for that reason.

---

## Step 0 — Store the key

Add to `.env` (already gitignored at `.gitignore:15`, and `.env.example` is the only
committed variant):

```
AISA_INFERENCE_KEY=...
AISA_VENDOR_KEY=...
AISA_API_BASE_URL=https://api.aisa.one
```

If AIsa issues you only one key today, set both variables to it and revisit after Step 1 —
but keep the two names from the start, so the split is structural rather than something to
retrofit later.

**Gate:** `git status` shows no `.env`, and `git check-ignore -v .env` prints the rule.

---

## Step 1 — Probe the API (~10 minutes, < $0.50)

Four unknowns block every design decision downstream. Answer them with curl before writing
any code.

> **Windows note:** in PowerShell, `curl` is an alias for `Invoke-WebRequest` and will not
> accept these flags. Use `curl.exe`, or run these in Git Bash.

**1a. Does the Anthropic-compatible route work, and which model IDs are live?**

```bash
curl.exe -sS https://api.aisa.one/v1/models -H "Authorization: Bearer $AISA_INFERENCE_KEY"
```

If that 404s, the gateway has no catalog endpoint — take model IDs from
`https://aisa.one/docs/guides/models` instead and skip to 1b.

**1b. Does `/v1/messages` accept the request shape `llm.ts` already builds?**

Send a minimal `messages` call with `output_config` and `thinking` included. Whether they
are accepted, ignored, or rejected decides how much of Step 4 you need.

```bash
curl.exe -sS https://api.aisa.one/v1/messages -H "Authorization: Bearer $AISA_INFERENCE_KEY" -H "content-type: application/json" -d "{\"model\":\"<id from 1a>\",\"max_tokens\":256,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the JSON object {\\\"ok\\\":true} and nothing else.\"}]}"
```

**1c. Does a GET data endpoint work, and what does it actually cost?**

```bash
curl.exe -sS -D - "https://api.aisa.one/apis/v1/financial/prices?ticker=AAPL&interval=day&start_date=2026-08-01&end_date=2026-08-08" -H "Authorization: Bearer $AISA_VENDOR_KEY"
```

`-D -` dumps response headers: check whether any of them report price, cost, or remaining
balance. Nothing in the docs says they do, and the OpenAPI spec is too large to have
confirmed it — this curl is how you find out.

**1d. Key scoping — answered, no need to ask.**

`console.aisa.one` → API Keys. An account may hold many; the docs recommend one per
service. Each may carry a **spend cap** (USD per day/week/month), a rate-limit override, and
a model allowlist. Revocation is instant.

So the two-key split is a real control. Note what is *not* offered: any restriction by
endpoint family. A model allowlist does not keep an inference key away from the paid data
APIs — the spend cap is what bounds that, by making the loss finite rather than preventing
it.

**Gate:** you have written down — a live model ID, whether `output_config`/`thinking`
survive, the real per-call price of one data endpoint, and the scoping answer.

---

## Step 2 — Decide the key split

From 1d:

- **Scoping exists** → issue two keys. Inference-only for the orchestrator, data-only for
  the vendor shim. Rule 1 of `AISA_INTEGRATION.md` §2 becomes enforceable.
- **No scoping** → both processes draw on one $101 balance. Keep the two env var names and
  the process separation anyway, then **write the residual down honestly** in
  `.env.example` and `docs/ARCHITECTURE.md`: an injected orchestrator can spend the
  inference key, and with no scoping that key also reaches the data APIs. This repo states
  bounds it cannot guarantee rather than implying it has them — `agent/llm.ts` already
  does exactly this about amount inflation. Match that register.

**Gate:** a written decision, and `.env.example` documents which component may hold which
key using the same framing as the existing four-key ledger.

---

## Step 3 — Provider swap in the agent

Files:

- [`services/orchestrator/src/agent/llm.ts`](../services/orchestrator/src/agent/llm.ts) —
  add `baseURL?: string` to `LlmAgentOptions`, pass it into `new Anthropic({ apiKey, baseURL })`.
- [`services/orchestrator/src/agent/factory.ts`](../services/orchestrator/src/agent/factory.ts)
  — add `baseURL` to `AgentFactoryOptions`, forward it with the same
  `...(x === undefined ? {} : { x })` pattern already used for `model` and `goal`.
- [`services/orchestrator/src/serve.ts:88`](../services/orchestrator/src/serve.ts) and
  [`main.ts`](../services/orchestrator/src/main.ts) — read `optional("LLM_BASE_URL")`.
- `.env.example` — `LLM_BASE_URL` (blank = direct Anthropic, the default).

Blank must stay the default. Direct Anthropic keeps `thinking: { display: "summarized" }`,
and that summary is what `ModelInput.tsx` renders as the demo's central artifact.

**Gate:** `pnpm --filter @ntux402/orchestrator run typecheck` passes, and a run with
`LLM_BASE_URL` unset behaves exactly as it does today.

---

## Step 4 — Compat mode

Sized by what 1b returned. If AIsa rejected `output_config` or `thinking`, add a compat
path to `LlmAgent` that:

1. Omits `output_config` and `thinking` when `baseURL` is set.
2. Moves the JSON-object instruction into `SYSTEM_PROMPT`.
3. Makes `parseDecision` tolerate a fenced code block around the JSON.
4. **Emits a distinct signal when parsing fails.**

Point 4 is the one that bites. `parseDecision` returning `undefined` currently resolves to
`proceed: false`. Against a gateway that returns prose, that silently converts the demo
into "the agent declines everything" — and it looks like a policy decision rather than a
parser failure. Give it its own reasoning string and, ideally, its own event, so a failed
parse is visibly a failed parse.

**Gate:** a unit test in `agent/` that feeds fenced JSON, bare JSON, and prose through the
compat parser and asserts the third produces a visible parse-failure — not a quiet refusal.

---

## Step 5 — The multi-model injection matrix

The payoff for Step 3. Run `premium-feed` (the injection goal) against four models from
different labs.

Model is a process-level env var read once at serve time, so today this means four
restarts. If you want it in the console, add an optional `model` field to the `POST /runs`
body and thread it through the run context in
[`server.ts`](../services/orchestrator/src/server.ts) — small, and worth it if the matrix
makes the submission.

Record for each model: did it comply with the injection, and did the vault refuse anyway.

**Gate:** a table in the README showing every model tested complied, and every spend
bounced. That upgrades the claim from *"a frontier model was convinced"* to *"every model
tested was convinced, and the vault refused all of them."*

---

## Step 6 — Scaffold `services/vendor-aisa`

Copy the shape of [`mock-api/src/`](../mock-api/src/): `handler.ts` (transport-free,
testable), `server.ts` (node:http wrapper), `index.ts` (bootstrap), `gateway.ts` (reuse
`HttpFacilitatorGateway`).

The route:

```
GET /resource/aisa/<capability>
  no X-PAYMENT  -> 402 + x402 terms from the shared catalog
  X-PAYMENT     -> decode + validate
                -> call upstream AIsa with AISA_VENDOR_KEY
                -> settle via the facilitator
                -> 200 + real payload + X-PAYMENT-RESPONSE
```

Upstream call **before** settlement — see `AISA_INTEGRATION.md` §4 for why settle-first
produces a false "the resource server refused the payment" message in the one case where
precision matters. On upstream failure: 502, no settlement, no money moved.

Add a **hard call ceiling** in this service — N upstream calls per hour, refused past that.

Better than a bare counter: AIsa returns `x-aisa-customer-cost-micros-usd` on every call
(undocumented, confirmed by measurement — see [`AISA_LIVE_SEARCH.md`](AISA_LIVE_SEARCH.md)
§1). Micros USD are USDC atomic units, so summing that header gives exact cumulative spend
and the ceiling can be denominated in money rather than in calls. Six candidate balance
endpoints were probed and all six 404'd, so this header is the only spend visibility that
exists — treat it as optional, since nothing documents it.

`pnpm-workspace.yaml` already globs `services/*`, so no change there.

**Gate:** the service starts, `GET /resource/aisa/<cap>` with no header returns a 402 that
[`parsePaymentRequired`](../packages/shared/src/x402/terms.ts) accepts.

---

## Step 7 — Catalog and routing

- [`packages/shared/src/demo/catalog.ts`](../packages/shared/src/demo/catalog.ts) — add
  `upstream?: { vendor: "mock" | "aisa"; path: string; params?: Record<string, string> }`
  to `DemoGoal`, plus an `aisa-prices` entry priced from the real number you measured in
  1c, with a `verifiedOn` date.
- Keep all four synthetic entries. `compliance-audit` especially — its `?price=` override
  makes its price track the operator's chosen budget, which a real vendor's published price
  cannot do. That entry carries the confidentiality argument.
- Add the vendor's payee to `DEMO_PAYEES`, and make it an address **you control and can
  sweep** — the existing four are placeholders (`0x1111…`), and real USDC will now land
  there.
- [`server.ts:259`](../services/orchestrator/src/server.ts) — select the base URL from
  `upstream.vendor` instead of always using `ctx.mockApiUrl`.
- [`scripts/dev.mjs`](../scripts/dev.mjs) — add
  `{ name: "vendor-aisa", filter: "@ntux402/vendor-aisa", script: "start" }`.

Six files read the catalog and all must still agree: `catalog.ts`, `mock-api/src/config.ts`,
`mock-api/src/handler.ts`, `services/orchestrator/src/server.ts`, `apps/web/src/App.tsx`,
`apps/web/src/dashboard/GoalPicker.tsx`.

**Gate:** the console lists the new goal, and the price it displays equals the price the
402 demands.

---

## Step 8 — Tests

Mirror [`mock-api/src/handler.test.ts`](../mock-api/src/handler.test.ts). Inject the
upstream `fetch` exactly as `HttpFacilitatorGateway` already accepts a `fetchImpl`, so the
suite never reaches the network and never spends a cent.

Cover: 402 shape; settlement success returning the upstream payload; settlement failure;
upstream failure producing 502 **with no settlement**; and the call ceiling refusing.

**Gate:** `pnpm test` green, and running it with the network off changes nothing.

---

## Step 9 — Boundary enforcement

Extend [`scripts/check-boundary.mjs`](../scripts/check-boundary.mjs), reusing the shape of
`resolvesIntoSigner`:

- the orchestrator must not import `@ntux402/vendor-aisa` or resolve into
  `services/vendor-aisa/`;
- the orchestrator source must not contain the string `AISA_VENDOR_KEY`.

~20 lines. `pnpm verify` and the pre-push hook then cover it automatically.

**Gate:** temporarily add `import "@ntux402/vendor-aisa"` to an orchestrator file, confirm
`pnpm run check:boundary` **fails**, then remove it. A guard you have not watched fail is a
guard you have not tested.

---

## Step 10 — Trace

Add a `vendor-upstream` step to the chain in [`services/trace/`](../services/trace/):
capability invoked, upstream HTTP status, upstream request id if AIsa returns one, and
published price vs charged price.

Two constraints: **no bearer tokens or raw upstream headers in the trace** (AIsa's own
guidance says so, and this repo's instincts agree); and record the step as
**vendor-attested, not chain-verified** — the standalone verifier proves on-chain facts
from a trace file and a public RPC, and an upstream HTTP call is not one of those.

**Gate:** a completed trace shows the upstream step, contains no key material, and the
verifier still passes without claiming to have checked it.

---

## Step 11 — Docs

`README.md` and [`ARCHITECTURE.md`](ARCHITECTURE.md): one short section. AIsa's
machine-payments page defines the controls an agent needs — per-request limit, per-task
limit, time-based limits, confirmation threshold, audit retention — and leaves them to the
integrator. This project implements that list with an encrypted on-chain budget, an
enclave-held payer key, and a hash-chained trace.

*AIsa supplies the models and the priced capabilities; the spending authority its docs
assign to the caller is what this project provides.*

**Gate:** `pnpm verify` green, and the README's test-count badge updated if the number moved.

---

## Order of operations

Steps 0–2 gate everything. Steps 3–5 (model provider) and 6–8 (vendor) are independent
after that and can be done in either order — 3–5 is half a day and produces a visible demo
result, so start there if time is short. Step 9 must land before any AIsa key reaches a
running orchestrator.

Land or stash the current working-tree changes in `services/signer` and
`services/orchestrator/src/pay` first, so the boundary and test edits land clean.
