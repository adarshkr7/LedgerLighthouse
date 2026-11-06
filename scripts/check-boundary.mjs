#!/usr/bin/env node
// Enforces the ARCHITECTURE.md trust model: the orchestrator is untrusted and must not
// be able to reach the components that hold spending authority. This checks import *paths*
// (relative and bare), not the presence of viem/signing libraries in general — the
// orchestrator legitimately holds the relay key (gas-only, see ARCHITECTURE.md) and needs a wallet
// client for that. What it must never do is import those packages or read from their source
// trees, however the import is spelled.
//
// The boundary: services/signer holds the payer key, and compromise there is arbitrary USDC
// spend. The orchestrator talks to it over HTTP and never links against it.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve, sep } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
const orchestratorSrc = join(repoRoot, "services", "orchestrator", "src");
const orchestratorPkgPath = join(repoRoot, "services", "orchestrator", "package.json");

/** Each forbidden reach: a source tree, the package name that resolves to it, and why. */
const FORBIDDEN = [
  {
    label: "signer",
    dir: join(repoRoot, "services", "signer") + sep,
    pkg: "@ntux402/signer",
    reason: "ARCHITECTURE.md trust model — the orchestrator holds no spending authority",
  },
];

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
function resolvesInto(specifier, fromFile, target) {
  if (specifier.startsWith(".")) {
    const resolved = resolve(dirname(fromFile), specifier);
    return (resolved + sep).startsWith(target.dir) || resolved === target.dir.slice(0, -1);
  }
  return specifier === target.pkg || specifier.startsWith(`${target.pkg}/`);
}

let violations = [];

for (const file of walk(orchestratorSrc)) {
  const src = readFileSync(file, "utf8");

  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(src))) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    for (const target of FORBIDDEN) {
      if (resolvesInto(specifier, file, target)) {
        const line = src.slice(0, match.index).split("\n").length;
        violations.push(
          `${relative(repoRoot, file)}:${line} imports "${specifier}" (${target.label}) — ${target.reason}`,
        );
      }
    }
  }
}

if (existsSync(orchestratorPkgPath)) {
  const pkg = JSON.parse(readFileSync(orchestratorPkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const target of FORBIDDEN) {
    if (deps[target.pkg]) {
      violations.push(`services/orchestrator/package.json declares a dependency on ${target.pkg}`);
    }
  }
}

/*
 * The signer's own boundary. The x402 SDKs are large and had 25 vulnerabilities reported
 * against them in 2026. They belong in the facilitator, which is outside the trust model,
 * and must never be linked into the process that holds payer keys, directly or through
 * the shared package it imports.
 */
for (const [label, srcDir, pkgPath] of [
  ["services/signer", join(repoRoot, "services", "signer", "src"), join(repoRoot, "services", "signer", "package.json")],
  ["packages/shared", join(repoRoot, "packages", "shared", "src"), join(repoRoot, "packages", "shared", "package.json")],
]) {
  for (const file of walk(srcDir)) {
    const src = readFileSync(file, "utf8");
    let match;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(src))) {
      const specifier = match[1] ?? match[2];
      if (specifier && (specifier.startsWith("@x402/") || specifier === "x402")) {
        const line = src.slice(0, match.index).split("\n").length;
        violations.push(`${relative(repoRoot, file)}:${line} imports "${specifier}" — the x402 SDKs stay out of the signer`);
      }
    }
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (name.startsWith("@x402/") || name === "x402") {
      violations.push(`${label}/package.json declares a dependency on ${name} — the x402 SDKs stay out of the signer`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    "Dependency boundary violated: services/orchestrator must not reach the signer.\n",
  );
  for (const v of violations) console.error(`  - ${v}`);
  console.error("\nSee the trust model in ARCHITECTURE.md.");
  process.exit(1);
}

console.log(
  `Boundary check passed: services/orchestrator does not reach ${FORBIDDEN.map((t) => t.label).join(", ")}.`,
);
