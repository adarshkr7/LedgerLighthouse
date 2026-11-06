/**
 * Recomputes a benchmark's statistics from its raw records, so the figures can be
 * checked without trusting the summary stored in the file. Reads only.
 *
 *   pnpm --filter @ntux402/e2e run bench:stats ../../docs/runs/bench-2026-11-02.json
 *
 * Medians and percentiles interpolate between neighbouring samples. Overhead is
 * each paid call's total minus its settlement stage: an estimate, since there is
 * no measured plain-x402 control.
 */

import { readFileSync } from "node:fs";

interface BenchRecord {
  readonly phase: string;
  readonly t: Readonly<Record<string, number>>;
  readonly requestSpendGas?: string;
  readonly finalizeGas?: string;
}

const file = process.argv[2];
if (!file) throw new Error("name a benchmark JSON file");
const { records } = JSON.parse(readFileSync(file, "utf8")) as { records: BenchRecord[] };

function quantile(values: readonly number[], p: number): number {
  const v = [...values].sort((a, b) => a - b);
  const at = p * (v.length - 1);
  const below = Math.floor(at);
  return v[below]! + (v[Math.ceil(at)]! - v[below]!) * (at - below);
}

function row(label: string, values: readonly number[], scale: number, digits: number): void {
  const f = (x: number) => (Math.round((x * 10 ** digits) / scale) / 10 ** digits).toFixed(digits);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  console.log(
    `  ${label.padEnd(26)} median ${f(quantile(values, 0.5))}  mean ${f(mean)}  ` +
      `p10-p90 ${f(quantile(values, 0.1))}-${f(quantile(values, 0.9))}  ` +
      `min-max ${f(Math.min(...values))}-${f(Math.max(...values))}`,
  );
}

const STAGES: readonly (readonly [string, string, string])[] = [
  ["commit", "agent", "committed"],
  ["decision available", "committed", "revealed"],
  ["finalize", "revealed", "finalized"],
  ["sign in enclave", "finalized", "signed"],
  ["settle and receive data", "signed", "settled"],
];

for (const phase of ["approved", "rejected"]) {
  const set = records.filter((r) => r.phase === phase);
  console.log(`${phase}, n=${set.length} (seconds)`);
  for (const [label, from, to] of STAGES) {
    if (set[0]?.t[to] === undefined) continue;
    row(label, set.map((r) => r.t[to]! - r.t[from]!), 1000, 2);
  }
  row("end to end", set.map((r) => r.t["done"]!), 1000, 2);
  if (phase === "approved") {
    row("overhead estimate", set.map((r) => r.t["done"]! - (r.t["settled"]! - r.t["signed"]!)), 1000, 2);
  }
  row("requestSpend gas", set.map((r) => Number(r.requestSpendGas)), 1, 0);
  row("finalizeDecision gas", set.map((r) => Number(r.finalizeGas)), 1, 0);
}
