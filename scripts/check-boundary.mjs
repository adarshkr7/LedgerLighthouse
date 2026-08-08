#!/usr/bin/env node
// Enforces IMPLEMENTATION.md §3 / Non-negotiable #1: the orchestrator is untrusted and must not
// be able to reach the Authorization Signer's code or its workspace package. This checks import
// *paths* (relative and bare), not the presence of viem/signing libraries in general — the
// orchestrator legitimately holds the relay key (gas-only, see plan §5.1) and needs a wallet
// client for that. What it must never do is import the signer package or read from its source
// tree, however the import is spelled.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve, sep } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
const orchestratorSrc = join(repoRoot, "services", "orchestrator", "src");
const orchestratorPkgPath = join(repoRoot, "services", "orchestrator", "package.json");
const signerDir = join(repoRoot, "services", "signer") + sep;

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) files.push(full);
  }
  return files;
}

/** Resolve a possibly-extensionless relative specifier against the importing file's directory. */
function resolvesIntoSigner(specifier, fromFile) {
  if (specifier.startsWith(".")) {
    const resolved = resolve(dirname(fromFile), specifier);
    return (resolved + sep).startsWith(signerDir) || resolved === signerDir.slice(0, -1);
  }
  return specifier === "@ntux402/signer" || specifier.startsWith("@ntux402/signer/");
}

let violations = [];

for (const file of walk(orchestratorSrc)) {
  const src = readFileSync(file, "utf8");
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(src))) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    if (resolvesIntoSigner(specifier, file)) {
      const line = src.slice(0, match.index).split("\n").length;
      violations.push(`${relative(repoRoot, file)}:${line} imports "${specifier}"`);
    }
  }
}

if (existsSync(orchestratorPkgPath)) {
  const pkg = JSON.parse(readFileSync(orchestratorPkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps["@ntux402/signer"]) {
    violations.push(
      `services/orchestrator/package.json declares a dependency on @ntux402/signer`,
    );
  }
}

if (violations.length > 0) {
  console.error("Dependency boundary violated: services/orchestrator must not import the signer.\n");
  for (const v of violations) console.error(`  - ${v}`);
  console.error("\nSee IMPLEMENTATION.md §1 non-negotiable #1 and §3 target layout.");
  process.exit(1);
}

console.log("Boundary check passed: services/orchestrator does not import services/signer.");
