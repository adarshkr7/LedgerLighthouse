#!/usr/bin/env node
/**
 * Measures what a Tavily search actually costs, per tier.
 *
 *   node scripts/aisa-measure-tiers.mjs
 *
 * The x402 shim has to quote
 * `maxAmountRequired` in the 402, before the upstream call happens, so it needs
 * a deterministic price per tier rather than the actual cost of the call it is
 * about to make. AIsa publishes no per-call price for this endpoint and their
 * own pricing guidance says to measure with representative requests instead of
 * copying a number out of an article. This is that measurement.
 *
 * The grid varies depth and result count independently, because the tier table
 * is only meaningful once we know which of the two actually moves the price —
 * or whether it is flat and the tiers should collapse into one.
 *
 * Spends real credits: 4 search calls, plus free 404s while looking for a
 * balance endpoint. Reads AISA_VENDOR_KEY (falling back to AISA_INFERENCE_KEY)
 * from .env and never prints it.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");

function loadEnv() {
  const path = join(repoRoot, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!/^["']/.test(value)) value = value.startsWith("#") ? "" : value.split(/\s+#/)[0].trim();
    value = value.replace(/^(["'])(.*)\1$/, "$2");
    if (value !== "" && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();

const BASE = (process.env["AISA_API_BASE_URL"] ?? "https://api.aisa.one").replace(/\/$/, "");
const KEY = process.env["AISA_VENDOR_KEY"] ?? process.env["AISA_INFERENCE_KEY"];

if (!KEY) {
  console.error("Set AISA_VENDOR_KEY or AISA_INFERENCE_KEY in .env and re-run.");
  process.exit(1);
}

const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const rule = (t) => console.log(`\n${"-".repeat(72)}\n${t}\n${"-".repeat(72)}`);

console.log(`base url : ${BASE}`);
console.log(`key      : loaded from .env, ${KEY.length} chars (not shown)`);
console.log(`spend    : 4 paid search calls`);

// ------------------------------------------------ A. is there a balance read?

rule("A. Looking for a balance / credits endpoint (free — 404s cost nothing)");

const BALANCE_CANDIDATES = [
  "/v1/credits",
  "/v1/balance",
  "/v1/usage",
  "/v1/me",
  "/apis/v1/account/balance",
  "/apis/v1/usage",
];

let balancePath;
for (const path of BALANCE_CANDIDATES) {
  try {
    const res = await fetch(`${BASE}${path}`, { headers });
    console.log(`   ${path.padEnd(28)} HTTP ${res.status}`);
    if (res.ok && !balancePath) {
      balancePath = path;
      const body = await res.text();
      console.log(`      -> ${body.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`   ${path.padEnd(28)} unreachable: ${e.message}`);
  }
}

console.log(
  balancePath
    ? `\n   balance endpoint found: ${balancePath} — will measure deltas`
    : `\n   none found. Cost must come from the response's own usage object.`,
);

/** Best-effort numeric balance, for before/after deltas. undefined when unavailable. */
async function readBalance() {
  if (!balancePath) return undefined;
  try {
    const res = await fetch(`${BASE}${balancePath}`, { headers });
    if (!res.ok) return undefined;
    const body = await res.json();
    for (const field of ["balance", "credits", "remaining", "amount"]) {
      const v = body?.[field] ?? body?.data?.[field];
      if (typeof v === "number") return v;
      if (typeof v === "string" && !Number.isNaN(Number(v))) return Number(v);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------- B. the tier grid

rule("B. Measuring the grid — depth x result count");

const GRID = [
  { name: "basic/5", search_depth: "basic", max_results: 5 },
  { name: "basic/10", search_depth: "basic", max_results: 10 },
  { name: "advanced/5", search_depth: "advanced", max_results: 5 },
  { name: "advanced/10", search_depth: "advanced", max_results: 10 },
];

const QUERY = "base sepolia usdc contract address";
const rows = [];
const captureDir = join(repoRoot, "services", "orchestrator", "src", "agent", "__fixtures__");
mkdirSync(captureDir, { recursive: true });

for (const tier of GRID) {
  console.log(`\n   ${tier.name}`);
  const before = await readBalance();

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/apis/v1/tavily/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: QUERY,
        search_depth: tier.search_depth,
        max_results: tier.max_results,
        include_usage: true,
      }),
    });
  } catch (e) {
    console.log(`     unreachable: ${e.message}`);
    rows.push({ ...tier, status: "ERR", credits: "-", results: "-", ms: "-" });
    continue;
  }
  const elapsed = Date.now() - started;

  console.log(`     HTTP ${res.status}  (${elapsed} ms wall)`);

  // Any header naming cost is what the shim would use to reconcile.
  const costHeaders = [];
  res.headers.forEach((value, key) => {
    if (/cost|price|credit|balance|usage|quota|ratelimit/i.test(key)) {
      costHeaders.push(`${key}: ${value}`);
    }
  });
  if (costHeaders.length > 0) console.log(`     headers: ${costHeaders.join(" | ")}`);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.log(`     ${text.replace(/\s+/g, " ").slice(0, 240)}`);
    rows.push({ ...tier, status: String(res.status), credits: "-", results: "-", ms: elapsed });
    continue;
  }

  const body = await res.json();
  writeFileSync(
    join(captureDir, `tavily-${tier.name.replace("/", "-")}.json`),
    JSON.stringify(body, null, 2),
  );

  const after = await readBalance();
  const delta = before !== undefined && after !== undefined ? before - after : undefined;

  const usage = body?.usage;
  const credits =
    typeof usage === "object" && usage !== null
      ? (usage.credits ?? usage.cost ?? JSON.stringify(usage).slice(0, 40))
      : (usage ?? "(none)");

  console.log(`     usage      : ${JSON.stringify(usage) ?? "(none)"}`);
  console.log(`     request_id : ${body?.request_id ?? "(none)"}`);
  console.log(`     results    : ${Array.isArray(body?.results) ? body.results.length : 0}`);
  console.log(`     answer     : ${body?.answer ? "present" : "absent"}`);
  if (delta !== undefined) console.log(`     balance delta: ${delta}`);

  rows.push({
    ...tier,
    status: "200",
    credits: String(credits),
    results: Array.isArray(body?.results) ? body.results.length : 0,
    ms: elapsed,
    delta: delta ?? "-",
  });
}

// ------------------------------------------------------------- the summary

rule("C. Tier table — the numbers the x402 shim needs");

const pad = (s, n) => String(s).padEnd(n);
console.log(
  `   ${pad("tier", 14)}${pad("http", 7)}${pad("credits", 22)}${pad("results", 9)}${pad("ms", 7)}delta`,
);
for (const r of rows) {
  console.log(
    `   ${pad(r.name, 14)}${pad(r.status, 7)}${pad(r.credits, 22)}${pad(r.results, 9)}${pad(r.ms, 7)}${r.delta ?? "-"}`,
  );
}

const distinct = new Set(rows.filter((r) => r.status === "200").map((r) => r.credits));
console.log(
  `\n   ${
    distinct.size <= 1
      ? "Cost does not vary across the grid — collapse to a single flat tier."
      : "Cost varies — the tier table needs a row per distinct price."
  }`,
);
console.log(`   Raw responses saved to services/orchestrator/src/agent/__fixtures__/`);
console.log(`   Convert credits -> USD from the AIsa dashboard, then + margin -> USDC atomic.\n`);
