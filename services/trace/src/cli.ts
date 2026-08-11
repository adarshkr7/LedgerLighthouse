/**
 * Standalone trace verifier.
 *
 *   npx tsx src/cli.ts <trace.json> [--rpc <url>] [--offline]
 *   pnpm --filter @ntux402/trace run verify -- trace.json
 *
 * Deliberately takes a file and an RPC URL and nothing else. If this needed a
 * running service it would not be a verifier — it would be a second opinion
 * from the same party (ARCHITECTURE.md §8.4).
 */

import { readFileSync } from "node:fs";

import { loadDotEnv, optional } from "@ntux402/shared/node";
import { USDC_BASE_SEPOLIA } from "@ntux402/shared";

import type { Trace } from "./step.js";
import { verifyTrace } from "./verify.js";

loadDotEnv();

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const offline = args.includes("--offline");
const rpcFlag = args[args.indexOf("--rpc") + 1];
const rpcUrl = offline ? undefined : (rpcFlag && !rpcFlag.startsWith("--") ? rpcFlag : optional("BASE_SEPOLIA_RPC_URL"));

if (!file) {
  console.error("usage: verify <trace.json> [--rpc <url>] [--offline]");
  process.exit(2);
}

const trace = JSON.parse(readFileSync(file, "utf8")) as Trace;

console.log(`\nVerifying ${file}`);
console.log(`  goal   ${trace.goalId}`);
console.log(`  vault  ${trace.vault}`);
console.log(`  chain  ${trace.chainId}`);
console.log(`  steps  ${trace.steps.length}`);
console.log(`  root   ${trace.root}`);
console.log(`  mode   ${rpcUrl ? "hash chain + on-chain cross-checks" : "hash chain only (offline)"}\n`);

const result = await verifyTrace(trace, {
  ...(rpcUrl ? { rpcUrl } : {}),
  usdcAddress: USDC_BASE_SEPOLIA,
});

for (const finding of result.findings) {
  const where = finding.step === undefined ? "" : ` [step ${finding.step}]`;
  const mark = finding.severity === "error" ? "FAIL" : "warn";
  console.log(`  ${mark}${where}  ${finding.check}`);
  console.log(`        ${finding.detail}\n`);
}

console.log(`  ${result.checksRun} checks run\n`);

if (result.valid) {
  console.log(
    result.onChain
      ? "  VALID — the hash chain is intact and every attestation matches the chain.\n"
      : "  VALID (offline) — the hash chain is intact. On-chain claims were not checked.\n",
  );
  process.exit(0);
}

console.log("  INVALID — see the failures above.\n");
process.exit(1);
