import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Abi, Address, Hex } from "viem";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const BASE_SEPOLIA_CHAIN_ID = 84532;
/** Baked into @inco/lightning's Lib.sol. Verified live before deploying. */
export const INCO_SINGLETON = "0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624" as const;
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/** Minimal .env reader — no dependency, no interpolation, no surprises. */
export function loadDotEnv(): void {
  const path = join(REPO_ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip an inline comment only when the value is unquoted.
    if (!/^["']/.test(value)) value = value.split(/\s+#/)[0]!.trim();
    value = value.replace(/^(["'])(.*)\1$/, "$2");
    if (value !== "" && process.env[key] === undefined) process.env[key] = value;
  }
}

export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in, or export it in the shell.`,
    );
  }
  return value;
}

export function requiredHexKey(name: string): Hex {
  const raw = required(name);
  const withPrefix = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error(`${name} must be a 32-byte hex private key.`);
  }
  return withPrefix as Hex;
}

export function requiredAddress(name: string): Address {
  const raw = required(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`${name} must be a 20-byte hex address, got ${JSON.stringify(raw)}`);
  }
  return raw as Address;
}

/**
 * Reads the ABI straight out of the Foundry artifact rather than a checked-in
 * copy, so it cannot drift from the contract that was actually compiled.
 */
export function policyVaultAbi(): Abi {
  const artifact = join(REPO_ROOT, "contracts", "out", "PolicyVault.sol", "PolicyVault.json");
  if (!existsSync(artifact)) {
    throw new Error(`No Foundry artifact at ${artifact}. Run \`forge build\` in contracts/ first.`);
  }
  return JSON.parse(readFileSync(artifact, "utf8")).abi as Abi;
}

export const ms = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;
export const now = (): bigint => process.hrtime.bigint();

export function fmt(milliseconds: number): string {
  return milliseconds >= 1000
    ? `${(milliseconds / 1000).toFixed(2)}s`
    : `${milliseconds.toFixed(0)}ms`;
}
