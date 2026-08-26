#!/usr/bin/env node
// Enforces the ARCHITECTURE.md trust model: the orchestrator is untrusted and must not
// be able to reach the components that hold spending authority. This checks import *paths*
// (relative and bare), not the presence of viem/signing libraries in general — the
// orchestrator legitimately holds the relay key (gas-only, see ARCHITECTURE.md) and needs a wallet
// client for that. What it must never do is import those packages or read from their source
// trees, however the import is spelled.
//
// Two boundaries, one mechanism:
//
//   services/signer      holds the payer key. Compromise here is arbitrary USDC spend.
//   services/vendor-aisa holds AISA_VENDOR_KEY. Compromise here is arbitrary spend against a
//                        prepaid balance that PolicyVault never sees — no on-chain trace, no
//                        confidential budget, nothing to bounce off. See
//                        README.md.
//
// The second one also checks for the *credential name*, not just the import. A key does not
// need an import to leak: reading it straight out of `process.env` in the orchestrator would be
// enough, and it is the kind of line that arrives in a hurry during a demo.
//
// That scan is a plain substring match over the whole file, comments included, and it is meant
// to be. It means orchestrator source cannot so much as name the variable — a comment explaining
// the rule will fail the rule — which is mildly annoying and the correct trade: for a guard like
// this, a false positive costs a reworded sentence and a false negative costs the key. Anything
// cleverer (stripping comments first) risks skipping real code inside a string that happens to
// contain `//`, and a security check must not have that shape of hole.

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
  {
    label: "vendor-aisa",
    dir: join(repoRoot, "services", "vendor-aisa") + sep,
    pkg: "@ntux402/vendor-aisa",
    reason: "README.md — the vendor key must not reach the untrusted component",
  },
];

/** Credential names the orchestrator may never mention, by any spelling. */
const FORBIDDEN_ENV = ["AISA_VENDOR_KEY"];

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

  for (const name of FORBIDDEN_ENV) {
    const index = src.indexOf(name);
    if (index !== -1) {
      const line = src.slice(0, index).split("\n").length;
      violations.push(
        `${relative(repoRoot, file)}:${line} names ${name} — that credential belongs to ` +
          `services/vendor-aisa alone (README.md)`,
      );
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

if (violations.length > 0) {
  console.error(
    "Dependency boundary violated: services/orchestrator must not reach the signer or the AIsa vendor.\n",
  );
  for (const v of violations) console.error(`  - ${v}`);
  console.error("\nSee the trust model in ARCHITECTURE.md.");
  process.exit(1);
}

console.log(
  `Boundary check passed: services/orchestrator reaches neither ${FORBIDDEN.map((t) => t.label).join(" nor ")}.`,
);
