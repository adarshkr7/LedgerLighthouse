#!/usr/bin/env node
// Runs exactly what CI runs, locally, in the same order. If this passes, CI passes.
// The point is that you never learn about a broken build from a red check on GitHub.
//
//   pnpm verify                    full run
//   pnpm verify --skip-contracts   TS only (when Foundry isn't installed)

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, delimiter } from "node:path";
import { homedir } from "node:os";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
const skipContracts = process.argv.includes("--skip-contracts");

// foundryup installs to ~/.foundry/bin. Login shells pick that up; spawned
// subprocesses and git hooks often don't. Add it rather than fail confusingly.
const foundryBin = join(homedir(), ".foundry", "bin");
if (existsSync(foundryBin) && !(process.env.PATH ?? "").includes(foundryBin)) {
  process.env.PATH = `${foundryBin}${delimiter}${process.env.PATH ?? ""}`;
}

const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", BOLD = "\x1b[1m", OFF = "\x1b[0m";

/** Every JSON file git tracks is a file CI will parse. A stray comma breaks the whole workspace. */
function checkJson() {
  const skip = new Set(["node_modules", ".git", "dist", "out", "cache"]);
  const bad = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".json") && entry !== "package-lock.json") {
        try {
          JSON.parse(readFileSync(full, "utf8"));
        } catch (e) {
          bad.push(`${relative(repoRoot, full)} — ${e.message.split("\n")[0]}`);
        }
      }
    }
  })(repoRoot);
  if (bad.length) {
    return { ok: false, output: "Malformed JSON:\n" + bad.map((b) => "  " + b).join("\n") };
  }
  return { ok: true, output: "" };
}

// Commands are single strings run through a shell: on Windows `pnpm` is a .cmd
// shim that won't spawn directly, and Node's shell-plus-args form is deprecated.
// Every command here is a fixed literal — nothing is interpolated from input.
const steps = [
  { name: "json syntax", fn: checkJson },
  { name: "install (frozen lockfile)", cmd: "pnpm install --frozen-lockfile --ignore-scripts" },
  { name: "build (TS packages)", cmd: "pnpm build" },
  { name: "typecheck", cmd: "pnpm typecheck" },
  { name: "test (vitest)", cmd: "pnpm test" },
  { name: "boundary (orchestrator ↛ signer)", cmd: "pnpm check:boundary" },
  { name: "forge build", cmd: "forge build", cwd: "contracts", contracts: true },
  { name: "forge test", cmd: "forge test", cwd: "contracts", contracts: true },
];

console.log(`${BOLD}Verifying (mirrors .github/workflows/ci.yml)${OFF}\n`);

let failed = null;
for (const step of steps) {
  if (step.contracts && skipContracts) {
    console.log(`  ${DIM}skip${OFF}  ${step.name} ${DIM}(--skip-contracts)${OFF}`);
    continue;
  }
  process.stdout.write(`  ....  ${step.name}`);

  let ok, output;
  if (step.fn) {
    ({ ok, output } = step.fn());
  } else {
    const r = spawnSync(step.cmd, {
      cwd: step.cwd ? join(repoRoot, step.cwd) : repoRoot,
      encoding: "utf8",
      shell: true,
    });
    ok = r.status === 0;
    output = (r.stdout || "") + (r.stderr || "");
    if (!ok && step.contracts && /not recognized|not found/i.test(output)) {
      output += "\nFoundry isn't on PATH. Install: curl -L https://foundry.paradigm.xyz | bash && foundryup" +
        "\nOr rerun with --skip-contracts (CI will still check it).";
    }
  }

  process.stdout.write("\r");
  if (ok) {
    console.log(`  ${GREEN}pass${OFF}  ${step.name}     `);
  } else {
    console.log(`  ${RED}FAIL${OFF}  ${step.name}     `);
    failed = { step, output };
    break;
  }
}

if (failed) {
  console.log(`\n${RED}${BOLD}${failed.step.name} failed.${OFF} Fix this before pushing:\n`);
  console.log(failed.output.trimEnd() + "\n");
  process.exit(1);
}

console.log(`\n${GREEN}${BOLD}All checks passed.${OFF} CI will be green.\n`);
