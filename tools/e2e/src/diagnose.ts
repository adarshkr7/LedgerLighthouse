/**
 * Checks every part of the running system and says what is wrong with it.
 *
 *   pnpm diagnose
 *
 * It sends no transaction and moves no money. Each check prints ok, WARN or
 * FAIL, and every WARN and FAIL carries the fix. The exit code is non-zero
 * when anything FAILs, so it can gate a demo or a deploy.
 *
 * ## Why it exists
 *
 * The failures seen while making this run end to end were all diagnosable from
 * outside, and none of them said so on their own: a nonce reused because the
 * public RPC answered from a node behind its own receipt, a vault deployed
 * before the payer binding, an enclave signer crash-looping behind a proxy that
 * only ever said "connection refused", a ROFL machine expiring and taking its
 * key index with it, an Inco covalidator down. Each check below is one of those
 * questions, asked directly.
 *
 * `preflight` stays as it is: it answers "can I deploy". This answers "what is
 * wrong right now", against whatever is running.
 *
 * `pnpm dev` runs it once the services are up, with DIAGNOSE_QUIET=1 so only
 * the summary prints among the service logs.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, domainSeparator, formatEther, toFunctionSelector, type Address, type PublicClient, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rpcTransport, viemChain } from "@ntux402/shared/viem";
import { escrowPolicyVaultAbi, formatUsdc, rpcUrls, usdcAbi, type Network } from "@ntux402/shared";
import { IncoDecisionReader, IncoHealthProbe, connectLightning } from "@ntux402/orchestrator";

import { loadDotEnv, networkFromEnv, optional } from "./config.js";
import { paymentState } from "./escrow.js";

loadDotEnv();

// ----------------------------------------------------------------- reporting

type Level = "ok" | "warn" | "fail" | "skip";

interface Outcome {
  readonly level: Level;
  readonly detail: string;
  /** What to do about it. Required in spirit for every warn and fail. */
  readonly fix?: string | undefined;
}

interface Result extends Outcome {
  readonly area: string;
  readonly name: string;
}

const results: Result[] = [];
let currentArea = "";

const MARK: Record<Level, string> = { ok: "ok  ", warn: "WARN", fail: "FAIL", skip: "skip" };

/** Only the summary, for `pnpm dev`. */
const quiet = process.env["DIAGNOSE_QUIET"] === "1";
const say = (line: string) => {
  if (!quiet) console.log(line);
};

function area(name: string): void {
  currentArea = name;
  say(`\n  ${name}`);
}

function record(name: string, outcome: Outcome): void {
  results.push({ area: currentArea, name, ...outcome });
  say(`    ${MARK[outcome.level]}  ${name.padEnd(28)} ${outcome.detail}`);
  if (outcome.fix && outcome.level !== "ok") say(`          fix: ${outcome.fix}`);
}

/** Runs one check; an exception is a FAIL with its first line, never a crash of the diagnosis. */
async function check(name: string, run: () => Promise<Outcome>, fix?: string): Promise<void> {
  try {
    record(name, await run());
  } catch (error) {
    record(name, { level: "fail", detail: brief(error), fix });
  }
}

/** First line of an error, with URL paths cut: RPC URLs carry API keys. */
function brief(error: unknown): string {
  const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
  if (/^fetch failed$/.test(first)) return "nothing answered (connection refused, reset or DNS failure)";
  if (/aborted due to timeout|TimeoutError/i.test(first)) return "no answer within the timeout";
  return redact(first).slice(0, 200);
}

function redact(text: string): string {
  return text.replace(/(https?:\/\/[^/\s]+)[^\s]*/g, "$1/…");
}

const origin = (url: string) => redact(url).replace(/\/…$/, "");

async function getJson(url: string, init: RequestInit = {}, timeoutMs = 10_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: body as Record<string, unknown> };
}

// ------------------------------------------------------------- configuration

say("\ndiagnose\n");
area("configuration");

let network: Network | undefined;
let rpcUrl = "";
let usdcAddress: Address | undefined;
await check(
  "network",
  async () => {
    ({ network, rpcUrl, usdcAddress } = networkFromEnv());
    return {
      level: "ok",
      detail: `${network.label} (chain ${network.chainId})${network.testnet ? "" : ", REAL MONEY"}`,
    };
  },
  "fix the setting the error names in .env. NETWORK picks the network; CHAIN_ID and USDC_ADDRESS, if set, must agree with it.",
);

const vaultRaw = optional("POLICY_VAULT_ADDRESS");
const vault = vaultRaw && /^0x[0-9a-fA-F]{40}$/.test(vaultRaw) ? (vaultRaw as Address) : undefined;
record(
  "vault address",
  vault
    ? { level: "ok", detail: vault }
    : { level: "fail", detail: vaultRaw ? `not an address: ${vaultRaw}` : "POLICY_VAULT_ADDRESS is not set", fix: "set POLICY_VAULT_ADDRESS to the deployed PolicyVault (README, What is deployed)." },
);

function roleAddress(variable: string): Address | undefined {
  const raw = optional(variable);
  if (!raw) return undefined;
  try {
    return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex).address;
  } catch {
    return undefined;
  }
}
const relay = roleAddress("ORCHESTRATOR_RELAY_KEY");
const settler = roleAddress("FACILITATOR_PRIVATE_KEY");
const deployer = roleAddress("DEPLOYER_PRIVATE_KEY");
record(
  "relay key",
  relay
    ? { level: "ok", detail: relay }
    : { level: "fail", detail: "ORCHESTRATOR_RELAY_KEY is missing or malformed", fix: "pnpm --filter @ntux402/e2e run keygen" },
);

if (!network || !vault) {
  finish();
}
const net = network!;
const client = createPublicClient({ chain: viemChain(net), transport: rpcTransport(rpcUrl) });

// --------------------------------------------------------------------- chain

area("chain");

/*
 * Every configured endpoint on its own, then whether they agree. A list whose
 * members are blocks apart is what produced the reused nonce and the false
 * SpendPending on 9 October: a read right after a write lands on a node that
 * has not seen it.
 */
const heads: { url: string; block: bigint }[] = [];
for (const url of rpcUrls(rpcUrl)) {
  await check(
    `rpc ${origin(url)}`,
    async () => {
      const single = createPublicClient({ chain: viemChain(net), transport: rpcTransport(url) });
      const started = Date.now();
      const [chainId, block] = await Promise.all([single.getChainId(), single.getBlockNumber()]);
      const ms = Date.now() - started;
      if (chainId !== net.chainId) {
        return { level: "fail", detail: `chain ${chainId}, expected ${net.chainId}`, fix: "this endpoint is for another network; fix RPC_URL." };
      }
      heads.push({ url, block });
      return ms > 3_000
        ? { level: "warn", detail: `block ${block}, ${ms} ms`, fix: "this endpoint is slow; put a faster one first in RPC_URL." }
        : { level: "ok", detail: `block ${block}, ${ms} ms` };
    },
    "the endpoint did not answer; remove it from RPC_URL or replace it.",
  );
}
if (heads.length > 1) {
  const blocks = heads.map((h) => h.block);
  const spread = Number(blocks.reduce((a, b) => (a > b ? a : b)) - blocks.reduce((a, b) => (a < b ? a : b)));
  record(
    "rpc agreement",
    spread > 3
      ? {
          level: "warn",
          detail: `endpoints are ${spread} blocks apart`,
          fix: "reads right after a write may be stale. The code retries the known cases, but a dedicated RPC provider removes the cause; use one on mainnet.",
        }
      : { level: "ok", detail: `within ${spread} block(s) of each other` },
  );
}

await check("vault contract", async () => {
  const code = await client.getCode({ address: vault! });
  if (!code || code === "0x") {
    return { level: "fail", detail: `no contract at ${vault}`, fix: `POLICY_VAULT_ADDRESS is wrong for ${net.label}, or the vault was never deployed there.` };
  }
  const escrowVault = code.includes(toFunctionSelector("escrowPayment(uint256,uint64)").slice(2));
  return escrowVault
    ? { level: "ok", detail: "EscrowPolicyVault deployed" }
    : {
        level: "fail",
        detail: "not an EscrowPolicyVault: this code spends through the escrow",
        fix: "deploy EscrowPolicyVault and point POLICY_VAULT_ADDRESS at it, or use the arxiv-v1.1 tag for the old vault.",
      };
});

await check("usdc signing domain", async () => {
  const onChain = (await client.readContract({ address: usdcAddress!, abi: usdcAbi, functionName: "DOMAIN_SEPARATOR" })) as Hex;
  const expected = domainSeparator({
    domain: { name: net.usdc.eip712Name, version: net.usdc.eip712Version, chainId: net.chainId, verifyingContract: usdcAddress! },
  });
  return onChain.toLowerCase() === expected.toLowerCase()
    ? { level: "ok", detail: `"${net.usdc.eip712Name}" v${net.usdc.eip712Version} matches the token` }
    : {
        level: "fail",
        detail: `the token's EIP-712 domain is not "${net.usdc.eip712Name}" v${net.usdc.eip712Version}`,
        fix: "the USDC entry in NETWORKS (packages/shared/src/chain/network.ts) is wrong for this token; every authorization would be rejected at settlement.",
      };
});

async function gas(name: string, address: Address | undefined, floorEth: string, fix: string): Promise<void> {
  if (!address) return;
  await check(name, async () => {
    const balance = await client.getBalance({ address });
    const floor = BigInt(Math.round(Number(floorEth) * 1e18));
    return balance < floor
      ? { level: "warn", detail: `${formatEther(balance)} ETH at ${address}`, fix }
      : { level: "ok", detail: `${formatEther(balance)} ETH` };
  });
}
await gas("relay gas", relay, "0.001", "requests and finalizeDecision will fail. Top up with pnpm --filter @ntux402/e2e run fund.");
await gas("facilitator gas", settler, "0.0005", "settlement will fail. Top up with pnpm --filter @ntux402/e2e run fund.");
await gas("deployer gas", deployer, "0.003", "opening goals and sweeping will fail. Fund it from a faucet.");

// ---------------------------------------------------------------------- inco

area("inco");

const probeHandle = (optional("INCO_PROBE_HANDLE") as Hex | undefined) ?? net.incoProbeHandle;
if (!probeHandle) {
  record("reveal", {
    level: "skip",
    detail: `no revealed decision is known on ${net.label} to probe with`,
    fix: "set INCO_PROBE_HANDLE once a first run has revealed one.",
  });
} else {
  await check("reveal", async () => {
    const zap = await connectLightning(net, rpcUrl);
    const health = await new IncoHealthProbe(new IncoDecisionReader(zap), { handle: probeHandle }).check();
    return health.status === "ready"
      ? { level: "ok", detail: `answered in ${(health.latencyMs / 1000).toFixed(1)}s` }
      : {
          level: "fail",
          detail: health.detail,
          fix: "Inco cannot reveal decisions, so every run stops at the confidential evaluation. This is Inco's side; wait it out, or run a local Inco node.",
        };
  });
}

// ------------------------------------------------------------------ services

area("services");

const signerUrl = optional("SIGNER_URL") ?? `http://127.0.0.1:${process.env["SIGNER_PORT"] ?? 8402}`;
const signerToken = optional("SIGNER_SERVICE_TOKEN") ?? optional("SERVICE_TOKEN");
const enclave = /\.rofl\.app/.test(signerUrl);
let signerUp = false;
let orchestratorUp = false;
let custody: { store?: string; keys?: number } | undefined;

await check(
  `signer ${origin(signerUrl)}`,
  async () => {
    const { status, body } = await getJson(`${signerUrl}/health`);
    if (status === 503 && body["state"] === "boot-failed") {
      return {
        level: "fail",
        detail: `boot failed at ${String(body["stage"])}: ${String(body["detail"])} (attempt ${String(body["attempts"])})`,
        fix: String(body["hint"] ?? "read the detail; the signer retries boot every 30 seconds."),
      };
    }
    if (status !== 200 || body["ok"] !== true) {
      return { level: "fail", detail: `HTTP ${status}`, fix: "the signer answered but not as a healthy signer; check SIGNER_URL." };
    }
    signerUp = true;
    custody = body["custody"] as { store?: string; keys?: number } | undefined;
    if (body["vault"] === undefined) {
      return { level: "warn", detail: "healthy, but too old to report its vault", fix: "restart or redeploy the signer on current code." };
    }
    const sameVault = String(body["vault"]).toLowerCase() === vault!.toLowerCase();
    const sameChain = body["chainId"] === net.chainId;
    if (!sameVault || !sameChain) {
      return {
        level: "fail",
        detail: `reads vault ${String(body["vault"])} on chain ${String(body["chainId"])}`,
        fix: enclave
          ? "the enclave's POLICY_VAULT_ADDRESS secret names another vault: oasis rofl secret set, oasis rofl update, then restart the machine."
          : "restart the signer so it reads POLICY_VAULT_ADDRESS from .env.",
      };
    }
    return { level: "ok", detail: `healthy, reads this vault${enclave ? ", in the ROFL enclave" : ", local key store"}` };
  },
  enclave
    ? "nothing answers at SIGNER_URL. If the machine is running, the container may be crash-looping: `oasis rofl machine logs` shows the VM side, and a current signer reports its own boot failure on /health."
    : "start it with pnpm dev.",
);

/*
 * The token, without side effects. Every protected route checks the bearer
 * before anything else, so an empty body to /authorizations answers 401 when
 * the token is wrong and 400 when it is right, and touches nothing.
 */
if (!signerUp) {
  record("signer token", { level: "skip", detail: "the signer is not serving; see above" });
} else await check("signer token", async () => {
  const { status } = await getJson(`${signerUrl}/authorizations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(signerToken ? { authorization: `Bearer ${signerToken}` } : {}) },
    body: "{}",
  });
  if (status === 401) {
    return {
      level: "fail",
      detail: "the signer rejects this token",
      fix: "SIGNER_SERVICE_TOKEN in .env must equal the signer's SERVICE_TOKEN (the ROFL secret, for the enclave).",
    };
  }
  if (status === 503) return { level: "skip", detail: "the signer is not running; see above" };
  return { level: "ok", detail: signerToken ? "accepted" : "no token needed" };
});

// From the signer's own report when it gives one, from its URL otherwise.
const store = custody?.store ?? (enclave ? "rofl" : signerUp ? "file" : undefined);
const held = custody?.keys === undefined ? "" : `, ${custody.keys} payer key(s) reachable`;
if (store === "rofl") {
  record("signer custody", { level: "ok", detail: `payer keys are derived in the ROFL enclave${held}` });
} else if (store !== undefined) {
  record("signer custody", {
    level: net.testnet ? "warn" : "fail",
    detail: `${store === "memory" ? "in-memory key store: keys are lost on restart" : "local signer: payer keys are in a file on this machine"}${held}`,
    fix: "fine for a demo. For real custody, deploy the signer to ROFL and set SIGNER_URL to its proxy address.",
  });
}

const orchestratorUrl = optional("ORCHESTRATOR_URL") ?? `http://127.0.0.1:${process.env["ORCHESTRATOR_PORT"] ?? 8404}`;
await check(
  `orchestrator ${origin(orchestratorUrl)}`,
  async () => {
    const { status, body } = await getJson(`${orchestratorUrl}/config`);
    if (status !== 200) return { level: "fail", detail: `/config answered HTTP ${status}` };
    const problems: string[] = [];
    if (String(body["vaultAddress"]).toLowerCase() !== vault!.toLowerCase()) problems.push(`vault ${String(body["vaultAddress"])}`);
    if (body["chainId"] !== net.chainId) problems.push(`chain ${String(body["chainId"])}`);
    if (problems.length > 0) {
      return { level: "fail", detail: `disagrees with .env: ${problems.join(", ")}`, fix: "restart the orchestrator so it reads the current .env." };
    }
    orchestratorUp = true;
    const notes = [`settlement ${String(body["settlement"])}`, `agent ${String(body["agent"])}`];
    return body["settlement"] === "stub"
      ? { level: "warn", detail: notes.join(", "), fix: "no money moves. Set X402_FACILITATOR_URL for live settlement." }
      : { level: "ok", detail: notes.join(", ") };
  },
  "start it with pnpm dev.",
);

if (!orchestratorUp) {
  record("orchestrator inco gate", { level: "skip", detail: "the orchestrator is not serving; see above" });
} else await check("orchestrator inco gate", async () => {
  const { body } = await getJson(`${orchestratorUrl}/health/inco`, {}, 30_000);
  if (body["status"] === "ready") return { level: "ok", detail: "runs are allowed" };
  if (body["status"] === "unchecked") return { level: "warn", detail: "unchecked, runs are allowed", fix: "set INCO_PROBE_HANDLE so runs are refused while Inco is down." };
  return { level: "fail", detail: `runs are refused: ${String(body["detail"])}`, fix: "Inco cannot reveal decisions; see the inco section." };
});

const facilitatorUrl = optional("X402_FACILITATOR_URL");
if (facilitatorUrl) {
  await check(`facilitator ${origin(facilitatorUrl)}`, async () => {
    const { status } = await getJson(`${facilitatorUrl}/health`);
    return status === 200 ? { level: "ok", detail: "healthy" } : { level: "fail", detail: `HTTP ${status}` };
  }, "start it with pnpm dev; without it, settlement fails.");
}

const mockApiUrl = optional("MOCK_API_URL") ?? `http://127.0.0.1:${process.env["MOCK_API_PORT"] ?? 4021}`;
let vendor: Address | undefined;
await check(`mock vendor ${origin(mockApiUrl)}`, async () => {
  const { status, body } = await getJson(`${mockApiUrl}/health`);
  if (status !== 200) return { level: "fail", detail: `HTTP ${status}` };
  if (body["settlement"] !== "escrow") {
    return { level: "fail", detail: `settlement ${String(body["settlement"])}`, fix: "restart it on the current code." };
  }
  if (String(body["vault"]).toLowerCase() !== vault!.toLowerCase()) {
    return { level: "fail", detail: `it sells for vault ${String(body["vault"])}`, fix: "restart it so it reads the current .env." };
  }
  vendor = body["vendor"] as Address;
  return { level: "ok", detail: `settlement escrow, vendor ${vendor}` };
}, "start it with pnpm dev.");
await gas("vendor gas", vendor, "0.0005", "the vendor sends its own claim. Without gas it holds payments and cannot take them. Top it up.");

// ----------------------------------------------------------- enclave machine

if (enclave) {
  area("enclave machine");
  await check("rental", async () => {
    const signerDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "services", "signer");
    const shown = spawnSync("oasis rofl machine show", { cwd: signerDir, encoding: "utf8", timeout: 90_000, shell: true });
    if (shown.error || shown.status !== 0) {
      const text = `${shown.stdout ?? ""}${shown.stderr ?? ""}`;
      if (/not found/i.test(text)) {
        return { level: "fail", detail: "the machine no longer exists", fix: "it expired. oasis rofl deploy --replace-machine rents a new one; the signer rebuilds its keys from the chain." };
      }
      return { level: "skip", detail: "could not run `oasis rofl machine show` here" };
    }
    const paid = /Paid until:\s*(.+)/.exec(shown.stdout)?.[1]?.trim();
    const status = /Status:\s*(\S+)/.exec(shown.stdout)?.[1];
    if (!paid) return { level: "warn", detail: `status ${status ?? "unknown"}, no expiry shown` };
    const minutes = Math.round((new Date(paid.replace(/ ([+-]\d{2})(\d{2}) \w+$/, "$1:$2")).getTime() - Date.now()) / 60_000);
    if (Number.isNaN(minutes)) return { level: "ok", detail: `status ${status}, paid until ${paid}` };
    if (minutes <= 0) return { level: "fail", detail: `expired at ${paid}`, fix: "oasis rofl deploy --replace-machine" };
    return minutes < 30
      ? { level: "warn", detail: `status ${status}, ${minutes} min left`, fix: "oasis rofl machine top-up --term hour --term-count 1" }
      : { level: "ok", detail: `status ${status}, ${minutes} min left` };
  });
}

// --------------------------------------------------------------------- vault

area("vault");

await check("goals", async () => {
  const count = (await client.readContract({ address: vault!, abi: escrowPolicyVaultAbi, functionName: "goalCount" })) as bigint;
  const first = count > 200n ? count - 199n : 1n;
  const stuck: string[] = [];
  let stranded = 0n;
  let strandedGoals = 0;
  for (let id = first; id <= count; id++) {
    const [owner, payer, , , , , , open] = (await client.readContract({
      address: vault!,
      abi: escrowPolicyVaultAbi,
      functionName: "goals",
      args: [id],
    })) as readonly [Address, Address, Address, Address, number, bigint, bigint, boolean];
    const pending = (await client.readContract({ address: vault!, abi: escrowPolicyVaultAbi, functionName: "pendingSeq", args: [id] })) as bigint;
    if (open && pending !== 0n) stuck.push(`${id} (seq ${pending})`);
    if (payer.toLowerCase() === owner.toLowerCase()) continue;
    const balance = (await client.readContract({ address: usdcAddress!, abi: usdcAbi, functionName: "balanceOf", args: [payer] })) as bigint;
    if (balance > 0n) {
      stranded += balance;
      strandedGoals++;
    }
  }
  if (stuck.length > 0) {
    return {
      level: "warn",
      detail: `${count} goals; a spend is committed but not finalized on goal ${stuck.join(", ")}`,
      fix: "that goal refuses new spends until it is finalized. Usually Inco was down mid-run; once it is back, rerun the goal or finalize it.",
    };
  }
  return strandedGoals > 0
    ? {
        level: "warn",
        detail: `${count} goals; ${formatUsdc(stranded)} USDC sits in ${strandedGoals} payer(s)`,
        fix: "pnpm --filter @ntux402/e2e run sweep lists them and returns what it can.",
      }
    : { level: "ok", detail: `${count} goals, no stuck spends, no USDC left in payers` };
});

await check("unpaid approvals", async () => {
  // An approved spend whose authorization expired unused still holds its amount
  // out of the budget until `reclaimExpired`, and one the escrow holds past the
  // capture deadline also holds money. The payment loop reclaims what expires
  // within two minutes; this catches the rest, on recent goals.
  const read = (functionName: string, args: readonly unknown[]) =>
    client.readContract({ address: vault!, abi: escrowPolicyVaultAbi, functionName, args } as Parameters<
      typeof client.readContract
    >[0]);
  const count = (await read("goalCount", [])) as bigint;
  const first = count > 200n ? count - 199n : 1n;
  const found: string[] = [];
  for (let id = first; id <= count; id++) {
    const goal = (await read("goals", [id])) as readonly [Address, Address, Address, Address, number, bigint, bigint, boolean];
    const [, , , , , , lastSeq, open] = goal;
    for (let seq = lastSeq > 10n ? lastSeq - 9n : 1n; seq <= lastSeq; seq++) {
      if (!((await read("isReclaimable", [id, seq])) as boolean)) continue;
      // A closed goal takes no more spends, so only money in the escrow matters there.
      if (open || (await paymentState(client as PublicClient, vault!, id, seq)).held > 0n) found.push(`${id}:${seq}`);
    }
  }
  return found.length > 0
    ? {
        level: "warn",
        detail: `${found.length} approved spend(s) expired unpaid and still hold budget: ${found.slice(0, 8).join(", ")}`,
        fix: "pnpm --filter @ntux402/e2e run reclaim -- --execute gives them back.",
      }
    : { level: "ok", detail: "every expired approval was paid or reclaimed" };
});

finish();

// -------------------------------------------------------------------- summary

function finish(): never {
  const fails = results.filter((r) => r.level === "fail");
  const warns = results.filter((r) => r.level === "warn");
  if (!quiet) console.log("");
  if (fails.length === 0 && warns.length === 0) {
    console.log(`  Everything checked is healthy (${results.length} checks).${quiet ? "" : "\n"}`);
  } else {
    console.log(`  ${fails.length} failure(s), ${warns.length} warning(s):`);
    for (const r of [...fails, ...warns]) {
      console.log(`    ${MARK[r.level]}  ${r.area} / ${r.name}`);
      if (r.fix) console.log(`          ${r.fix}`);
    }
    console.log("");
  }
  process.exit(fails.length > 0 ? 1 : 0);
}
