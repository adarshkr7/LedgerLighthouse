#!/usr/bin/env node
/**
 * Answers the AIsa unknowns that gate the live-search
 * integration, in one pass, for a few cents.
 *
 *   node scripts/aisa-probe.mjs [model-id ...]
 *
 * Reads AISA_INFERENCE_KEY (and optionally AISA_VENDOR_KEY) from .env. The key
 * is never printed, never written anywhere, and never placed on a command line
 * — so it stays out of shell history and out of this script's output.
 *
 * With no model ids given it probes whatever the catalog endpoint returns, up
 * to a small cap. Naming ids explicitly is the cheaper path once you know them.
 *
 * What it reports, per model:
 *   - whether the OpenAI-compatible route answers at all
 *   - which of the four reasoning shapes comes back
 *   - whether the reply parses as the {reasoning, proceed} decision object
 *
 * Responses are written to services/orchestrator/src/agent/__fixtures__/ so the
 * extraction layer can be tested against real gateway output without spending
 * anything further.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
const fixtureDir = join(repoRoot, "services", "orchestrator", "src", "agent", "__fixtures__");

/** Minimal .env reader — no dependency, and node's --env-file is not assumed. */
function loadEnv() {
  const path = join(repoRoot, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = (match[2] ?? "").trim();
    // Strip an inline comment only when the value is not quoted.
    if (!/^["']/.test(value)) value = value.split(/\s+#/)[0].trim();
    value = value.replace(/^["']|["']$/g, "");
    if (value !== "" && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();

const BASE = (process.env["AISA_API_BASE_URL"] ?? "https://api.aisa.one").replace(/\/$/, "");
const INFERENCE_KEY = process.env["AISA_INFERENCE_KEY"];
const VENDOR_KEY = process.env["AISA_VENDOR_KEY"] ?? INFERENCE_KEY;

if (!INFERENCE_KEY) {
  console.error("AISA_INFERENCE_KEY is not set. Add it to .env (which is gitignored) and re-run.");
  console.error("This script never prints or transmits the key anywhere but the gateway.");
  process.exit(1);
}

console.log(`base url : ${BASE}`);
console.log(`key      : loaded from .env, ${INFERENCE_KEY.length} chars (not shown)\n`);

const auth = (key) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
const rule = (t) => console.log(`\n${"-".repeat(66)}\n${t}\n${"-".repeat(66)}`);

// ------------------------------------------------------- A. model catalog

rule("A. GET /v1/models — does a catalog endpoint exist?");

let catalogIds = [];
try {
  const res = await fetch(`${BASE}/v1/models`, { headers: auth(INFERENCE_KEY) });
  console.log(`   HTTP ${res.status}`);
  if (res.ok) {
    const body = await res.json();
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    catalogIds = list.map((m) => m?.id).filter((id) => typeof id === "string");
    console.log(`   ${catalogIds.length} model ids returned`);
    if (catalogIds.length > 0) console.log(`   first few: ${catalogIds.slice(0, 8).join(", ")}`);
  } else {
    console.log(`   no catalog endpoint — take model ids from the docs instead`);
  }
} catch (e) {
  console.log(`   unreachable: ${e.message}`);
}

// ------------------------------------------- B. inference + reasoning shape

const requested = process.argv.slice(2);
const models = requested.length > 0 ? requested : catalogIds.slice(0, 4);

rule(`B. POST /v1/chat/completions — inference and reasoning shape`);

if (models.length === 0) {
  console.log("   No model ids to probe. Pass them as arguments:");
  console.log("   node scripts/aisa-probe.mjs <model-id> <model-id> ...");
} else {
  mkdirSync(fixtureDir, { recursive: true });
}

const SYSTEM = [
  "You are an autonomous purchasing agent. Reply with a single JSON object and nothing else:",
  '  {"reasoning": "<why>", "proceed": <true|false>}',
  "No prose before or after. No markdown code fence.",
].join("\n");

const USER =
  "Goal: assemble a market-data briefing.\n" +
  "Payment terms: 0.01 USDC to 0x1111111111111111111111111111111111111111 on base-sepolia.\n" +
  "Vendor description: Premium market data feed — single call, settled in USDC.\n" +
  "Should this spend be requested?";

const results = [];

for (const model of models) {
  process.stdout.write(`\n   ${model}\n`);
  let res;
  try {
    res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: auth(INFERENCE_KEY),
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: USER },
        ],
      }),
    });
  } catch (e) {
    console.log(`     unreachable: ${e.message}`);
    results.push({ model, status: "unreachable", shape: "-", parses: "-" });
    continue;
  }

  console.log(`     HTTP ${res.status}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.log(`     ${text.replace(/\s+/g, " ").slice(0, 200)}`);
    results.push({ model, status: String(res.status), shape: "-", parses: "-" });
    continue;
  }

  const body = await res.json();
  const safeName = model.replace(/[^\w.-]/g, "_");
  writeFileSync(join(fixtureDir, `${safeName}.json`), JSON.stringify(body, null, 2));

  const message = body?.choices?.[0]?.message ?? {};
  const content = typeof message.content === "string" ? message.content : "";

  let shape = "absent";
  let reasoning = "";
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim() !== "") {
    shape = "reasoning_content";
    reasoning = message.reasoning_content;
  } else if (typeof message.reasoning === "string" && message.reasoning.trim() !== "") {
    shape = "reasoning";
    reasoning = message.reasoning;
  } else {
    const inline = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i.exec(content);
    if (inline) {
      shape = "inline <think>";
      reasoning = inline[1] ?? "";
    }
  }

  // Same tolerance the agent applies: strip an inline block, then a fence.
  let bodyText = content.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/i, "").trim();
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(bodyText);
  if (fenced) bodyText = (fenced[1] ?? "").trim();

  let parses = "no";
  try {
    const parsed = JSON.parse(bodyText);
    parses =
      typeof parsed?.reasoning === "string" && typeof parsed?.proceed === "boolean"
        ? "yes"
        : "wrong shape";
  } catch {
    parses = "no";
  }

  console.log(`     reasoning shape : ${shape}${reasoning ? ` (${reasoning.length} chars)` : ""}`);
  console.log(`     decision parses : ${parses}`);
  if (parses !== "yes") console.log(`     raw: ${bodyText.replace(/\s+/g, " ").slice(0, 160)}`);

  results.push({ model, status: "200", shape, parses });
}

// ------------------------------------------------------ C. paid data route

rule("C. GET /apis/v1/financial/prices — a paid data route, and its headers");

try {
  const url =
    `${BASE}/apis/v1/financial/prices` +
    `?ticker=AAPL&interval=day&start_date=2026-08-01&end_date=2026-08-08`;
  const res = await fetch(url, { headers: auth(VENDOR_KEY) });
  console.log(`   HTTP ${res.status}`);

  // Any header naming cost, price, credits or balance is what the vendor shim
  // would need in order to know what it just spent. Nothing documents these.
  const interesting = [];
  res.headers.forEach((value, key) => {
    if (/cost|price|credit|balance|usage|quota|ratelimit/i.test(key)) {
      interesting.push(`${key}: ${value}`);
    }
  });
  console.log(
    interesting.length > 0
      ? `   cost/balance headers:\n     ${interesting.join("\n     ")}`
      : `   no cost/balance/quota headers — a local call ceiling is the only tripwire`,
  );

  if (res.ok) {
    const body = await res.json();
    const n = Array.isArray(body?.prices) ? body.prices.length : 0;
    console.log(`   body: ${n} price rows${body?.next_page_url ? ", paginated" : ""}`);
  } else {
    console.log(`   ${(await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200)}`);
  }
} catch (e) {
  console.log(`   unreachable: ${e.message}`);
}

// ------------------------------------------------------------- the summary

rule("Summary — fills the runbook Step 1 / thinking-plan Step 3 gates");

if (results.length > 0) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `   ${pad("model", 34)}${pad("http", 12)}${pad("reasoning", 18)}parses`,
  );
  for (const r of results) {
    console.log(`   ${pad(r.model, 34)}${pad(r.status, 12)}${pad(r.shape, 18)}${r.parses}`);
  }
  console.log(`\n   fixtures written to services/orchestrator/src/agent/__fixtures__/`);
  console.log(`   set LLM_MODEL in .env to whichever row you want the demo to use.`);
}

console.log(
  `\n   Still unanswered by curl: whether this account can hold two keys with\n` +
    `   separate scopes. Ask AIsa support — it decides whether the split in\n` +
    `   README.md is a real control or only process isolation.\n`,
);
