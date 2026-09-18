/**
 * Demo-day readiness. Everything that has to be true ten minutes before you present.
 *
 *   pnpm --filter @ntux402/e2e run showtime
 *   pnpm --filter @ntux402/e2e run showtime -- --spend    # also exercise the paid vendor path
 *
 * ## Not `preflight`
 *
 * `preflight` answers "can I deploy the contract" — artifact built, deployer
 * funded, Inco live. This answers a different question: **is the running system
 * about to work in front of an audience.** Six services, two RPC endpoints, two
 * API keys, three balances, and the handful of settings whose absence turns a
 * live demo into a stub without saying so.
 *
 * ## Blocking vs advisory
 *
 * A `FAIL` means the demo does not work. A `warn` means it works but is not
 * showing what you think it shows — a scripted agent instead of a model, stub
 * settlement instead of real USDC, anchoring switched off. Those are the ones
 * that embarrass you during questions rather than during the run, so they are
 * reported loudly and do not set the exit code.
 *
 * ## Cost
 *
 * Free by default, with one deliberate exception: it sends a one-token request
 * to the configured model. That call is a fraction of a cent when it works and
 * *free when it does not* — and "the model is gated behind a paid balance" is
 * exactly the failure worth catching before you are on stage rather than during.
 * The paid search probe costs ~$0.008 and is opt-in behind `--spend`.
 */

import { createPublicClient, formatEther } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { rpcTransport } from "@ntux402/shared/viem";
import { rpcUrls, SEARCH_TIERS, usdcAbi } from "@ntux402/shared";

import {
  BASE_SEPOLIA_CHAIN_ID,
  USDC_BASE_SEPOLIA,
  formatUsdc,
  loadDotEnv,
  optional,
  required,
} from "./config.js";

loadDotEnv();

const spend = process.argv.includes("--spend");

const failures: string[] = [];
const warnings: string[] = [];

const PAD = 32;

function pass(label: string, detail = "") {
  console.log(`  \x1b[32mpass\x1b[0m  ${label.padEnd(PAD)} ${detail}`);
}
function fail(label: string, detail: string) {
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label.padEnd(PAD)} ${detail}`);
  failures.push(`${label}: ${detail}`);
}
function warn(label: string, detail: string) {
  console.log(`  \x1b[33mwarn\x1b[0m  ${label.padEnd(PAD)} ${detail}`);
  warnings.push(`${label}: ${detail}`);
}
function check(label: string, ok: boolean, detail: string) {
  ok ? pass(label, detail) : fail(label, detail);
}
function rule(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** A short GET with a timeout, so one dead service cannot hang the whole check. */
async function get(url: string, ms = 4000): Promise<{ status: number; body: unknown } | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  } catch {
    return undefined;
  }
}

console.log("\n\x1b[1mShowtime — demo-day readiness\x1b[0m");

// ------------------------------------------------------------------ services

rule("Services");

const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const SERVICES = [
  { name: "signer", url: `http://127.0.0.1:${port("SIGNER_PORT", 8402)}/health`, blocking: true },
  { name: "facilitator", url: `http://127.0.0.1:${port("FACILITATOR_PORT", 8403)}/health`, blocking: true },
  { name: "orchestrator", url: `http://127.0.0.1:${port("ORCHESTRATOR_PORT", 8404)}/health`, blocking: true },
  { name: "mock-api", url: `http://127.0.0.1:${port("MOCK_API_PORT", 4021)}/health`, blocking: true },
  { name: "vendor-search", url: `http://127.0.0.1:${port("VENDOR_SEARCH_PORT", 4022)}/health`, blocking: false },
] as const;

let vendorHealth: Record<string, unknown> | undefined;

for (const service of SERVICES) {
  const res = await get(service.url);
  if (!res) {
    const detail = `not answering on ${service.url}`;
    service.blocking ? fail(service.name, detail) : warn(service.name, `${detail} — live search off`);
    continue;
  }
  if (service.name === "vendor-search") vendorHealth = res.body as Record<string, unknown>;
  pass(service.name, `${res.status} ${service.url.replace("/health", "")}`);
}

// The console is Vite, which serves HTML rather than JSON — a status is enough.
const web = await get("http://127.0.0.1:5173/");
if (web) pass("web console", "http://127.0.0.1:5173");
else fail("web console", "not answering on http://127.0.0.1:5173 — run `pnpm dev`");

// ------------------------------------------------------------ orchestrator

rule("Orchestrator configuration");

const config = (await get(`http://127.0.0.1:${port("ORCHESTRATOR_PORT", 8404)}/config`))?.body as
  | Record<string, unknown>
  | undefined;

if (!config) {
  fail("/config", "unreachable — every check below is unknown");
} else {
  check("chain", config["chainId"] === BASE_SEPOLIA_CHAIN_ID, String(config["chainId"]));

  config["settlement"] === "live"
    ? pass("settlement", "LIVE — real USDC moves")
    : warn("settlement", "STUB — payloads validated, no money moves. Set X402_FACILITATOR_URL.");

  config["agent"] === "llm"
    ? pass("agent", "live model")
    : warn("agent", "scripted stand-in — set LLM_API_KEY and LLM_MODEL for a real model");

  config["vendorSearchUrl"]
    ? pass("live search", String(config["vendorSearchUrl"]))
    : warn("live search", "not configured — the two search goals cannot run");

  config["vendorSearchPayee"]
    ? pass("vendor payee", String(config["vendorSearchPayee"]))
    : warn("vendor payee", "unset — VENDOR_SEARCH_PAYEE gates live search");
}

optional("TRACE_ANCHOR_ADDRESS")
  ? pass("trace anchoring", String(optional("TRACE_ANCHOR_ADDRESS")))
  : warn("trace anchoring", "TRACE_ANCHOR_ADDRESS unset — traces are not committed on chain");

// -------------------------------------------------------------------- chain

rule("Chain");

const rpcRaw = optional("BASE_SEPOLIA_RPC_URL");
if (!rpcRaw) {
  fail("BASE_SEPOLIA_RPC_URL", "unset");
} else {
  /*
   * Every endpoint, with `eth_call` rather than `eth_blockNumber`.
   *
   * The documented failure mode is an endpoint that answers a liveness probe
   * and then returns `-32011 no backend is currently healthy` for the contract
   * reads that actually matter. A check that only asks for the block height
   * passes cheerfully while the demo is already broken.
   */
  for (const url of rpcUrls(rpcRaw)) {
    const label = new URL(url).host;
    try {
      const client = createPublicClient({ chain: baseSepolia, transport: rpcTransport(url) });
      const chainId = await client.getChainId();
      const code = await client.getCode({ address: USDC_BASE_SEPOLIA });
      check(
        `rpc ${label}`,
        chainId === BASE_SEPOLIA_CHAIN_ID && (code?.length ?? 0) > 2,
        `chain ${chainId}, eth_call ok`,
      );
    } catch (e) {
      fail(`rpc ${label}`, e instanceof Error ? e.message.split("\n")[0]! : String(e));
    }
  }
}

// ----------------------------------------------------------------- balances

rule("Balances");

if (rpcRaw) {
  const client = createPublicClient({ chain: baseSepolia, transport: rpcTransport(rpcRaw) });

  /** Gas-only roles. Small floors — these submit transactions, they hold nothing. */
  const GAS_ROLES = [
    ["ORCHESTRATOR_RELAY_KEY", "relay"],
    ["FACILITATOR_PRIVATE_KEY", "facilitator"],
  ] as const;

  for (const [envName, label] of GAS_ROLES) {
    const raw = optional(envName);
    if (!raw) {
      fail(`${label} key`, `${envName} unset`);
      continue;
    }
    try {
      const { address } = privateKeyToAccount(raw as `0x${string}`);
      const balance = await client.getBalance({ address });
      // Enough for a handful of writes at Base Sepolia gas prices.
      check(
        `${label} ETH`,
        balance >= 500_000_000_000_000n, // 0.0005
        `${formatEther(balance)} — ${address}`,
      );
    } catch (e) {
      fail(`${label} key`, e instanceof Error ? e.message : String(e));
    }
  }

  const payee = optional("VENDOR_SEARCH_PAYEE");
  if (payee) {
    const owned = await client.readContract({
      address: USDC_BASE_SEPOLIA,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [payee as `0x${string}`],
    });
    pass("vendor revenue", `${formatUsdc(owned as bigint)} USDC at ${payee}`);
  }
}

console.log(
  `\n  \x1b[2mThe wallet that opens goals needs its own ETH and USDC — check MetaMask, not this.\x1b[0m`,
);

// ------------------------------------------------------------------ gateway

rule("gateway");

const base = (optional("LLM_BASE_URL") ?? "").replace(/\/$/, "");
const inferenceKey = optional("LLM_API_KEY");
const vendorKey = optional("SEARCH_VENDOR_KEY");

if (inferenceKey && vendorKey && inferenceKey === vendorKey) {
  warn("key separation", "inference and vendor keys are identical — see README.md");
} else if (inferenceKey && vendorKey) {
  pass("key separation", "two distinct keys");
}

const model = optional("LLM_MODEL");
if (!inferenceKey || !model) {
  warn("model", "LLM_API_KEY or LLM_MODEL unset — the scripted agent will run");
} else {
  // Free when it fails, which is the case worth catching.
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${inferenceKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      pass("model reachable", model);
    } else {
      const text = await res.text().catch(() => "");
      const code = /"code":"([^"]+)"/.exec(text)?.[1] ?? String(res.status);
      fail("model reachable", `${model} -> ${res.status} ${code}`);
    }
  } catch (e) {
    fail("model reachable", e instanceof Error ? e.message : String(e));
  }
}

if (vendorHealth) {
  const spent = BigInt(String(vendorHealth["spentAtomic"] ?? "0"));
  const cap = BigInt(String(vendorHealth["capAtomic"] ?? "0"));
  const room = cap > spent ? cap - spent : 0n;
  const calls = room / BigInt(SEARCH_TIERS.basic.priceAtomic);
  check(
    "vendor spend ceiling",
    calls > 5n,
    `${formatUsdc(spent)} of ${formatUsdc(cap)} used — room for ~${calls} more searches`,
  );
  vendorHealth["settlement"] === "live"
    ? pass("vendor settlement", "LIVE")
    : warn("vendor settlement", "stub — note the upstream call still costs real credits");
}

if (spend && vendorKey && optional("SEARCH_API_BASE_URL")) {
  const searchBase = (optional("SEARCH_API_BASE_URL") ?? "").replace(/\/$/, "");
  const res = await fetch(`${searchBase}/apis/v1/tavily/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${vendorKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "showtime check", search_depth: "basic", max_results: 5 }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
  if (!res) fail("vendor key (paid)", "request failed");
  else if (!res.ok) fail("vendor key (paid)", `HTTP ${res.status}`);
  else {
    const costHeader = optional("SEARCH_COST_HEADER");
    const cost = costHeader ? (res.headers.get(costHeader) ?? "?") : "unreported";
    pass("vendor key (paid)", `200, cost ${cost} µUSD`);
  }
} else if (vendorKey) {
  console.log(`  \x1b[2m       vendor key not exercised — re-run with --spend (~$0.008)\x1b[0m`);
}

// ------------------------------------------------------------------ summary

console.log("");
if (warnings.length > 0) {
  console.log(`\x1b[33m${warnings.length} advisory:\x1b[0m the demo runs, but check these read as intended.`);
  for (const w of warnings) console.log(`  - ${w}`);
  console.log("");
}

if (failures.length > 0) {
  console.log(`\x1b[31m${failures.length} blocking problem(s):\x1b[0m`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log("");
  process.exit(1);
}

console.log("\x1b[32m\x1b[1mReady.\x1b[0m Open a goal before you present, and keep a spare.\n");
