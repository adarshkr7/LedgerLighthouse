#!/usr/bin/env node
// Starts every service the demo needs, in one terminal.
//
//   pnpm dev
//
// Four processes, colour-coded, shut down together on Ctrl-C. Written because
// a five-minute demo should not begin with four terminal tabs and a prayer.
//
// The facilitator is started only when X402_FACILITATOR_URL is set. Without it
// the mock API runs in stub mode and says so — which is the honest default when
// there is no test USDC to move.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");

/** Minimal .env read — only to decide which services to start. */
function env() {
  const path = join(repoRoot, ".env");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (!/^["']/.test(value)) value = value.split(/\s+#/)[0].trim();
    out[trimmed.slice(0, eq).trim()] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

const config = env();

const COLOURS = ["\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[32m", "\x1b[34m"];
const OFF = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";

// Every service imports @ntux402/shared, which resolves through its `dist/`.
// `dist/` is gitignored, so a fresh clone has none and a branch switch can leave
// a stale one — either way the services die at import with a confusing
// "does not provide an export named …". Build it first; it takes a second, and
// it turns a baffling runtime error into a non-event.
process.stdout.write(`${DIM}Building @ntux402/shared…${OFF} `);
const build = spawnSync("pnpm --filter @ntux402/shared run build", {
  cwd: repoRoot,
  shell: true,
  encoding: "utf8",
});
if (build.status !== 0) {
  console.log(`${RED}failed${OFF}\n`);
  console.log((build.stdout ?? "") + (build.stderr ?? ""));
  process.exit(1);
}
console.log(`${DIM}ok${OFF}`);

const services = [
  { name: "signer", filter: "@ntux402/signer", script: "start" },
  { name: "mock-api", filter: "@ntux402/mock-api", script: "start" },
  ...(config.X402_FACILITATOR_URL
    ? [{ name: "facilitator", filter: "@ntux402/facilitator", script: "start" }]
    : []),
  { name: "orchestrator", filter: "@ntux402/orchestrator", script: "serve" },
  { name: "web", filter: "@ntux402/web", script: "dev" },
];

const width = Math.max(...services.map((s) => s.name.length));
const children = [];

console.log(`\n${DIM}Starting ${services.length} services. Ctrl-C stops all of them.${OFF}`);
if (!config.X402_FACILITATOR_URL) {
  console.log(
    `${DIM}X402_FACILITATOR_URL is unset — stub settlement, no USDC moves. ` +
      `Set it to start the facilitator.${OFF}`,
  );
}
console.log();

for (const [i, service] of services.entries()) {
  const colour = COLOURS[i % COLOURS.length];
  const label = `${colour}${service.name.padEnd(width)}${OFF} ${DIM}│${OFF} `;

  const child = spawn(`pnpm --filter ${service.filter} run ${service.script}`, {
    cwd: repoRoot,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  const prefix = (stream) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      // pnpm echoes the script it is about to run; that is noise here.
      for (const line of lines) {
        if (line.trim() === "" || line.startsWith("$ ")) continue;
        process.stdout.write(`${label}${line}\n`);
      }
    });
  };

  prefix(child.stdout);
  prefix(child.stderr);

  child.on("exit", (code) => {
    process.stdout.write(`${label}${DIM}exited (${code})${OFF}\n`);
  });
}

// `shell: true` means each child is a shell wrapping pnpm wrapping node. On
// Windows, killing the shell orphans the node grandchild, which keeps its port
// and greets the next `pnpm dev` with EADDRINUSE. Kill the tree, not the shell.
const kill = (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
};

let shuttingDown = false;
const stopAll = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${DIM}Stopping…${OFF}`);
  for (const child of children) kill(child);
  // Give them a moment to close listeners before the parent goes.
  setTimeout(() => process.exit(0), 500);
};

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
