#!/usr/bin/env node
/**
 * Records the demo, one step at a time, straight from the console.
 *
 *   pnpm record:demo                    # full flow: opens a goal, spends real test USDC
 *   pnpm record:demo -- --dry-run       # everything up to the first thing that spends
 *   pnpm record:demo -- --goal 61       # reuse an open goal; no wallet involved at all
 *
 * Writes `recordings/<stamp>/`: one webm of the whole take, a PNG per step, a
 * PNG per timeline stage inside each run, and `manifest.json` carrying the
 * millisecond offset of every one of them — so the edit can be cut from the
 * manifest instead of by scrubbing two minutes of mostly-waiting footage.
 *
 * ## Why there is no MetaMask here
 *
 * The console talks to an EIP-1193 provider and nothing else: `wagmi`'s
 * `injected()` connector reads `window.ethereum`, and `Root.tsx` checks for the
 * property's presence. A browser extension cannot be driven reliably from a
 * script, so this supplies its own provider — the page gets a shim whose
 * `request` forwards over a Playwright binding, and the signing happens in this
 * process against a local viem account.
 *
 * The key therefore never enters the page. That is not incidental. The console
 * is the component this project spends its README arguing holds no spending
 * authority, and a recording harness that injected a private key into it would
 * make that claim false for the length of the take — including on camera.
 *
 * ## --goal skips the wallet entirely
 *
 * A run is driven server-side, so an already-open goal can be exercised with no
 * wallet at all (the same reason `App.tsx` keeps its resume field outside the
 * connection branch). `--goal` uses that: no provider is injected, nothing is
 * signed, and the take starts at the first call. It is the cheap way to reshoot
 * the four calls after fluffing one, and the mode to reach for when the only
 * thing wrong with the last take was the narration.
 *
 * ## What a full take spends
 *
 * Real Base Sepolia gas and real test USDC: `openGoal` pays the Inco fee, the
 * funding step transfers `budget + 0.10`, and each approved call settles for
 * real. Two of the four calls are meant to be refused and cost only gas.
 * Nothing is spent before the "open goal" step, which is where `--dry-run`
 * stops.
 *
 * Prices, labels and expectations are read from `DEMO_GOALS` rather than
 * restated here, for the reason the catalog itself gives: a second copy is how
 * the displayed price and the charged price drift apart.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import {
  createPublicClient,
  createWalletClient,
  hexToBigInt,
  numberToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { rpcTransport } from "@ntux402/shared/viem";
import { DEMO_GOALS, type DemoGoal } from "@ntux402/shared";

import { formatUsdc, loadDotEnv, optional, REPO_ROOT, required } from "./config.js";

loadDotEnv();

/* ------------------------------------------------------------------ options */

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};

const CONSOLE_URL = optional("RECORD_CONSOLE_URL") ?? "http://127.0.0.1:5173";
const ORCHESTRATOR_URL =
  optional("RECORD_ORCHESTRATOR_URL") ??
  `http://127.0.0.1:${process.env["ORCHESTRATOR_PORT"] ?? 8404}`;

const dryRun = flag("dry-run");
const headless = flag("headless");
/** `chrome` or `msedge` to drive an installed browser rather than the bundled one. */
const channel = value("channel");
const resumeGoal = value("goal");
const slowMo = Number(value("slow") ?? 0);
const budgetUsdc = value("budget") ?? "0.30";

/*
 * 1600x1000 rather than 1920x1080. Playwright records the viewport at its own
 * pixel size, so a larger viewport does not sharpen the console's small type —
 * it only shrinks it relative to the frame. This is roughly the largest
 * viewport where the timeline still reads back on a phone.
 */
const VIEWPORT = { width: 1600, height: 1000 } as const;

/*
 * The four that carry the argument, in the order the argument is made: two
 * settle, then two are refused for different reasons. `--calls` overrides it,
 * which is mostly useful for re-shooting one segment against a resumed goal.
 */
const DEFAULT_CALLS = ["market-data", "bulk-archive", "compliance-audit", "premium-feed"];
const callKeys = (value("calls") ?? DEFAULT_CALLS.join(","))
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

/*
 * What each call is supposed to prove, so a take that quietly recorded the
 * wrong outcome says so at the end rather than in the edit. Advisory, never
 * fatal: `premium-feed` genuinely varies — the agent may decline the injection
 * on its own instead of being talked into asking — and the catalog is explicit
 * that neither branch is the better result.
 */
const EXPECTED: Record<string, string> = {
  "market-data": "Approved · settled",
  "bulk-archive": "Approved · settled",
  "compliance-audit": "Blocked by confidential policy",
  "premium-feed": "Blocked by confidential policy",
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = value("out") ?? join(REPO_ROOT, "recordings", stamp);
const shotDir = join(outDir, "shots");

/* ------------------------------------------------------------------- output */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

const timecode = (milliseconds: number): string => {
  const total = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
};

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const warnings: string[] = [];
const warn = (line: string): void => {
  warnings.push(line);
  console.log(`  ${YELLOW}warn${OFF}  ${line}`);
};

/* --------------------------------------------------------------- preflight */

interface OrchestratorConfig {
  readonly signerUrl: string;
  readonly mockApiUrl: string;
  readonly vendorAisaUrl?: string;
  readonly settlement: "live" | "stub";
  readonly agent: "llm" | "scripted";
  readonly agentModel?: string;
}

/**
 * Whether a service answered at all.
 *
 * Any HTTP status counts, 401 included: a ROFL-hosted signer demands a bearer
 * on its routes, and refusing this probe is it working correctly. Only a
 * transport failure — DNS, connection, TLS — means there is nothing there.
 */
async function reachable(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return { ok: true, detail: `http ${response.status}` };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function preflight(): Promise<OrchestratorConfig> {
  console.log(`\n${DIM}Preflight${OFF}`);

  const configResponse = await fetch(`${ORCHESTRATOR_URL}/config`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  if (!configResponse?.ok) {
    throw new Error(
      `no orchestrator on ${ORCHESTRATOR_URL}. Run \`pnpm dev\` from the repo root first — ` +
        `the web dev server alone does not start the backing services.`,
    );
  }
  const config = (await configResponse.json()) as OrchestratorConfig;
  console.log(`  ${GREEN}ok${OFF}    orchestrator            ${ORCHESTRATOR_URL}`);

  const web = await reachable(CONSOLE_URL);
  if (!web.ok) throw new Error(`no console on ${CONSOLE_URL}: ${web.detail}`);
  console.log(`  ${GREEN}ok${OFF}    console                 ${CONSOLE_URL}`);

  const probes: Array<{ label: string; url: string; blocking: boolean }> = [
    { label: "signer", url: `${config.signerUrl}/health`, blocking: !dryRun },
    { label: "mock api", url: `${config.mockApiUrl}/health`, blocking: !dryRun },
  ];
  if (config.vendorAisaUrl) {
    probes.push({ label: "vendor", url: `${config.vendorAisaUrl}/health`, blocking: false });
  }

  for (const probe of probes) {
    const result = await reachable(probe.url);
    if (result.ok) {
      console.log(`  ${GREEN}ok${OFF}    ${probe.label.padEnd(24)}${probe.url}`);
      continue;
    }
    if (!probe.blocking) {
      warn(`${probe.label} unreachable (${result.detail}) — ${probe.url}`);
      continue;
    }
    /*
     * Refusing here rather than recording is the whole point of a preflight.
     * A dead signer does not stop a run: the confidential evaluation still
     * happens, and the two refused calls still refuse correctly. What it kills
     * is the two calls that are supposed to *settle*, at the last stage, after
     * the gas is already spent — so the take looks like the system failing
     * rather than the system working, and costs real money to produce.
     */
    throw new Error(
      `${probe.label} is unreachable at ${probe.url} (${result.detail}).\n` +
        `  A take made now would spend gas and then fail at "Authorization signed" on every\n` +
        `  call that should have settled. Point SIGNER_URL at a signer that answers, or pass\n` +
        `  --dry-run to record only the steps that cost nothing.`,
    );
  }

  if (config.settlement !== "live") {
    warn(`settlement is "${config.settlement}" — payloads validate but no USDC moves on camera`);
  }
  if (config.agent !== "llm") {
    warn(`agent is "${config.agent}" — the scripted stand-in decides, not a model`);
  } else {
    console.log(
      `  ${GREEN}ok${OFF}    agent                   live LLM (${config.agentModel ?? "?"})`,
    );
  }

  return config;
}

/* ----------------------------------------------------------- wallet bridge */

/** The EIP-1193 shim the page gets. Forwards everything; decides nothing. */
const PROVIDER_SHIM = `(() => {
  const listeners = new Map();
  const provider = {
    isMetaMask: true,
    _isRecorder: true,
    async request(args) {
      const reply = await window.__llWallet(JSON.stringify(args ?? {}));
      const parsed = JSON.parse(reply);
      if (parsed.ok) return parsed.result;
      const error = new Error(parsed.error.message);
      error.code = parsed.error.code;
      throw error;
    },
    on(event, handler) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(handler);
      listeners.set(event, bucket);
      return provider;
    },
    removeListener(event, handler) {
      listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
      return provider;
    },
    enable() {
      return provider.request({ method: "eth_requestAccounts" });
    },
  };
  Object.defineProperty(window, "ethereum", {
    value: provider,
    configurable: true,
    writable: true,
  });
})();`;

interface Wallet {
  readonly address: Address;
  handle(raw: string): Promise<string>;
}

function walletBridge(): Wallet {
  const key = optional("RECORD_WALLET_KEY") ?? optional("DEPLOYER_PRIVATE_KEY");
  if (!key) {
    throw new Error(
      "no key to play the user with. Set RECORD_WALLET_KEY (preferred — it needs only the test " +
        "USDC being funded and a little gas) or DEPLOYER_PRIVATE_KEY, or pass --goal <id> to " +
        "record against an already-open goal with no wallet at all.",
    );
  }
  const account = privateKeyToAccount(key as Hex);
  const transport = rpcTransport(required("BASE_SEPOLIA_RPC_URL"));
  const reader = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport });

  async function dispatch(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address];
      case "eth_chainId":
        return numberToHex(baseSepolia.id);
      case "net_version":
        return String(baseSepolia.id);
      /*
       * The chain is already Base Sepolia and cannot be anything else, so both
       * of these are satisfied by definition. Null is the EIP-3326 success
       * value; throwing "unsupported" would drop the console into its
       * wrong-chain branch and stall the take on a Switch network button.
       */
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "wallet_getPermissions":
        return [];
      case "wallet_requestPermissions":
        return [{ parentCapability: "eth_accounts" }];
      case "personal_sign": {
        const [data] = params as [Hex];
        return account.signMessage({ message: { raw: data } });
      }
      case "eth_signTypedData_v4": {
        const [, payload] = params as [Address, string];
        return account.signTypedData(JSON.parse(payload));
      }
      /*
       * The one method that is not a forward. viem treats an injected account
       * as `json-rpc` and hands the wallet an unsigned transaction, expecting
       * it to fill gas and nonce, sign, and broadcast — which is exactly what a
       * local account's `sendTransaction` does.
       */
      case "eth_sendTransaction": {
        const [tx] = params as [{ to?: Address; data?: Hex; value?: Hex; gas?: Hex }];
        return wallet.sendTransaction({
          ...(tx.to ? { to: tx.to } : {}),
          ...(tx.data ? { data: tx.data } : {}),
          ...(tx.value ? { value: hexToBigInt(tx.value) } : {}),
          ...(tx.gas ? { gas: hexToBigInt(tx.gas) } : {}),
        });
      }
      default:
        return reader.request({ method, params } as never);
    }
  }

  return {
    address: account.address,
    async handle(raw: string): Promise<string> {
      const { method, params } = JSON.parse(raw) as { method: string; params?: unknown[] };
      try {
        return JSON.stringify({ ok: true, result: await dispatch(method, params ?? []) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        /*
         * Code 4001 is "user rejected". Nothing here rejects, so anything that
         * lands in this catch is a genuine fault and gets -32603 — which the
         * console renders verbatim, and that is what makes a broken take
         * diagnosable from the footage alone.
         */
        return JSON.stringify({ ok: false, error: { code: -32603, message } });
      }
    },
  };
}

/* ------------------------------------------------------------------- steps */

interface StageRecord {
  readonly label: string;
  readonly atMs: number;
  readonly shot: string;
}

interface StepRecord {
  readonly n: number;
  readonly id: string;
  readonly title: string;
  readonly atMs: number;
  readonly durationMs: number;
  readonly shot: string;
  readonly note?: string;
  readonly stages?: readonly StageRecord[];
}

const steps: StepRecord[] = [];
const pendingStages: StageRecord[] = [];
let started = 0;

/** Milliseconds since the first frame — the offset the edit is cut against. */
const elapsed = (): number => Date.now() - started;

async function step(
  page: Page,
  id: string,
  title: string,
  body: () => Promise<string | undefined>,
): Promise<void> {
  const n = steps.length + 1;
  const at = elapsed();
  process.stdout.write(`  ${String(n).padStart(2, "0")}  ${title.padEnd(34, " ")} `);

  let note: string | undefined;
  try {
    note = await body();
  } catch (error) {
    console.log(`${RED}failed${OFF}`);
    throw error;
  }

  const shot = `${String(n).padStart(2, "0")}-${id}.png`;
  await page.screenshot({ path: join(shotDir, shot) });
  steps.push({
    n,
    id,
    title,
    atMs: at,
    durationMs: elapsed() - at,
    shot,
    ...(note ? { note } : {}),
    ...(pendingStages.length ? { stages: [...pendingStages] } : {}),
  });
  pendingStages.length = 0;

  const suffix = note ? `  ${DIM}${note}${OFF}` : "";
  console.log(`${GREEN}captured${OFF}  ${DIM}${timecode(at)}${OFF}${suffix}`);
}

/* ------------------------------------------------------------------ driving */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate` holds, or gives up naming what it wanted. */
async function until(
  what: string,
  timeoutMs: number,
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
    }
    await sleep(400);
  }
}

/** The timeline as one comparable string, so a moved stage is a changed value. */
async function readStages(page: Page): Promise<string> {
  return page
    .$$eval("li.d-tl-item", (items) =>
      items
        .map((item) => {
          const label = item.querySelector(".d-tl-label")?.textContent ?? "";
          return `${label}=${item.getAttribute("data-status") ?? ""}`;
        })
        .join("|"),
    )
    .catch(() => "");
}

/** The verdict the console is currently showing, if any. */
async function readVerdict(page: Page): Promise<string | undefined> {
  return page
    .locator(".d-outcome-head")
    .first()
    .textContent({ timeout: 2000 })
    .then((text) => text?.trim() || undefined)
    .catch(() => undefined);
}

/**
 * Runs one resource and captures a frame each time the timeline moves.
 *
 * The run boundary is the Buy button's own disabled state rather than the
 * verdict text: two of these four calls settle and two are refused, so
 * consecutive runs produce identical verdict strings and watching the text
 * change would miss the second of each pair entirely.
 */
async function runCall(page: Page, goal: DemoGoal, stepIndex: number): Promise<string> {
  const buy: Locator = page.getByRole("button", { name: `Buy ${goal.label}`, exact: false });

  // Select it in the picker first. The Buy button is labelled with whatever is
  // selected, so it only answers to this name once that has happened.
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: goal.label, exact: false }).first().click();
  await buy.waitFor({ state: "visible", timeout: 15_000 });

  const stageDir = `${String(stepIndex).padStart(2, "0")}-${slug(goal.label)}`;
  mkdirSync(join(shotDir, stageDir), { recursive: true });

  await buy.click();
  await until("the run to start", 20_000, () => buy.isDisabled());

  let seen = "";
  let frame = 0;
  const capture = async (): Promise<void> => {
    const now = await readStages(page);
    if (now === "" || now === seen) return;
    seen = now;
    frame += 1;
    const last = now.split("|").filter(Boolean).pop() ?? "stage";
    const label = last.split("=")[0] ?? "stage";
    const shot = join(stageDir, `${String(frame).padStart(2, "0")}-${slug(label)}.png`);
    await page.screenshot({ path: join(shotDir, shot) });
    pendingStages.push({ label, atMs: elapsed(), shot });
  };

  /*
   * Six minutes. A run is normally well under one, but the deep-search tier
   * waits ~10s on the upstream API alone and the Inco reveal is polled with a
   * bound of its own — and a recorder that gives up early has thrown away the
   * gas it already spent.
   */
  const deadline = Date.now() + 360_000;
  for (;;) {
    await capture();
    if (!(await buy.isDisabled())) break;
    if (Date.now() > deadline) {
      throw new Error(`run of ${goal.label} did not finish within 6 minutes`);
    }
    await sleep(600);
  }
  await capture();

  const verdict = (await readVerdict(page)) ?? "no verdict shown";
  const expected = EXPECTED[goal.key];
  if (expected && verdict !== expected) {
    warn(`${goal.label}: expected "${expected}", got "${verdict}"`);
  }

  // Let the verdict sit on screen. The viewer needs a beat to read it, and a
  // hard cut off the last stage is the one edit that cannot be fixed later.
  await sleep(2500);
  return verdict;
}

/* -------------------------------------------------------------------- take */

async function record(config: OrchestratorConfig): Promise<void> {
  const goals = callKeys.map((key) => {
    const goal = DEMO_GOALS.find((candidate) => candidate.key === key);
    if (!goal) {
      const known = DEMO_GOALS.map((candidate) => candidate.key).join(", ");
      throw new Error(`unknown resource "${key}". The catalog has: ${known}`);
    }
    return goal;
  });

  const wallet = resumeGoal ? undefined : walletBridge();
  if (wallet) console.log(`  ${DIM}playing the user as ${wallet.address}${OFF}`);

  mkdirSync(shotDir, { recursive: true });

  /*
   * `--channel chrome` drives an installed Chrome or Edge instead of the
   * chromium Playwright bundles. It exists because the bundled build cannot be
   * launched headed on every Windows machine: `chrome.exe` declares a
   * dependency on an app-local side-by-side assembly, and where a security
   * policy refuses to resolve one, Windows reports
   *
   *   The application has failed to start because its side-by-side
   *   configuration is incorrect
   *
   * which no reinstall fixes, because nothing is missing. The headless shell
   * carries no such manifest and is unaffected — so the failure appears only
   * when recording headed, which is the mode you actually want on camera.
   */
  const browser = await chromium.launch({
    headless,
    ...(channel ? { channel } : {}),
    ...(slowMo ? { slowMo } : {}),
  });
  const context: BrowserContext = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: outDir, size: VIEWPORT },
    deviceScaleFactor: 2,
  });

  if (wallet) {
    await context.exposeFunction("__llWallet", (raw: string) => wallet.handle(raw));
    await context.addInitScript(PROVIDER_SHIM);
  }

  const page = await context.newPage();
  started = Date.now();

  console.log(`\n${DIM}Recording${OFF}`);

  try {
    await step(page, "landing", "landing page", async () => {
      await page.goto(CONSOLE_URL, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Launch console" }).waitFor({ timeout: 30_000 });
      // The hero animates in. Cutting to it mid-transition reads as a stutter.
      await sleep(2500);
      return undefined;
    });

    await step(page, "console", "console opens", async () => {
      await page.getByRole("button", { name: "Launch console" }).click();
      await page.getByRole("button", { name: "Set up a goal" }).waitFor({ timeout: 60_000 });
      await sleep(1200);
      return wallet ? `connected ${wallet.address.slice(0, 10)}…` : "no wallet — resume mode";
    });

    if (resumeGoal) {
      await step(page, "resume", `resume goal #${resumeGoal}`, async () => {
        await page.getByRole("button", { name: "Set up a goal" }).click();
        await page.locator("#resume").fill(resumeGoal);
        await page.getByRole("button", { name: "Resume", exact: true }).click();
        await page.getByRole("button", { name: "Buy", exact: false }).waitFor({ timeout: 30_000 });
        return `goal #${resumeGoal}`;
      });
    } else if (dryRun) {
      await step(page, "setup-dialog", "setup dialog (dry run)", async () => {
        await page.getByRole("button", { name: "Set up a goal" }).click();
        await page
          .getByRole("button", { name: "Mint ephemeral payer" })
          .waitFor({ timeout: 20_000 });
        await sleep(1200);
        return "stopped before anything that spends";
      });
      console.log(`\n  ${YELLOW}dry run${OFF} — stopped before the first step that spends.`);
      return;
    } else {
      await step(page, "mint-payer", "mint ephemeral payer", async () => {
        await page.getByRole("button", { name: "Set up a goal" }).click();
        await page.getByRole("button", { name: "Mint ephemeral payer" }).click();
        await page.getByRole("button", { name: "Payer minted" }).waitFor({ timeout: 60_000 });
        return undefined;
      });

      await step(page, "open-goal", `encrypt ${budgetUsdc} and open goal`, async () => {
        await page.locator("#budget").fill(budgetUsdc);
        await page.locator("#budget").blur();
        await page.getByRole("button", { name: "and open goal", exact: false }).click();
        /*
         * `openGoal` is a payable transaction plus an Inco fee read, and the
         * modal closes the moment it is dispatched. The goal panel replacing
         * the empty state is what says it landed — five minutes, because a
         * public RPC having a bad afternoon should not cost a take.
         */
        await page
          .getByRole("button", { name: "Fund", exact: false })
          .waitFor({ state: "visible", timeout: 300_000 });
        return `budget ${budgetUsdc} USDC, encrypted in the browser`;
      });

      await step(page, "fund", "fund the payer", async () => {
        const fund = page.getByRole("button", { name: "Fund", exact: false });
        const label = (await fund.textContent())?.trim();
        await fund.click();
        // The button is removed once `funded` is true, which is the signal.
        await fund.waitFor({ state: "detached", timeout: 300_000 });
        return label ?? undefined;
      });
    }

    for (const goal of goals) {
      const index = steps.length + 1;
      const title = `${goal.label} · ${formatUsdc(BigInt(goal.priceAtomic))}`;
      await step(page, slug(goal.label), title, () => runCall(page, goal, index));
    }

    await step(page, "evidence", "evidence rail", async () => {
      const evidence = page.getByRole("button", { name: /^Evidence/ }).first();
      if (await evidence.isVisible().catch(() => false)) {
        await evidence.click();
        await sleep(2000);
      }
      return resumeGoal ? `goal #${resumeGoal}` : undefined;
    });
  } finally {
    /*
     * The video is only flushed when the context closes, and its path can only
     * be read from a page that still exists — so the handle is taken first and
     * the file moved after. In `finally` because a take that fell over halfway
     * is still footage of what went wrong, and throwing that away is how you
     * end up unable to explain a failure you have already paid for.
     */
    const video = page.video();
    await context.close();
    if (video) {
      renameSync(await video.path(), join(outDir, "take.webm"));
    }
    await browser.close();

    const manifest = {
      recordedAt: new Date().toISOString(),
      console: CONSOLE_URL,
      orchestrator: ORCHESTRATOR_URL,
      settlement: config.settlement,
      agent: config.agent,
      agentModel: config.agentModel,
      mode: resumeGoal ? `resume #${resumeGoal}` : dryRun ? "dry-run" : "full",
      budgetUsdc: resumeGoal ? undefined : budgetUsdc,
      viewport: VIEWPORT,
      video: "take.webm",
      totalMs: elapsed(),
      steps,
      warnings,
    };
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  console.log(`\n${DIM}LedgerLighthouse — demo recorder${OFF}`);
  const config = await preflight();
  await record(config);

  console.log(`\n${DIM}Wrote${OFF} ${outDir}`);
  console.log(`  take.webm       ${DIM}${timecode(elapsed())} of footage${OFF}`);
  console.log(`  shots/          ${DIM}${steps.length} step frames, plus one per timeline stage${OFF}`);
  console.log(`  manifest.json   ${DIM}offsets to cut against${OFF}`);
  if (warnings.length) {
    console.log(
      `\n  ${YELLOW}${warnings.length} warning(s)${OFF} — the take recorded, but read them before you edit.`,
    );
  }
  console.log();
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`\n${RED}recording failed${OFF}  ${detail}\n`);
  process.exitCode = 1;
});
