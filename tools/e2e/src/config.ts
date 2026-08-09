import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Abi } from "viem";

export {
  loadDotEnv,
  optional,
  required,
  requiredAddress,
  requiredHexKey,
} from "@ntux402/shared/node";
export { BASE_SEPOLIA_CHAIN_ID, USDC_BASE_SEPOLIA, formatUsdc } from "@ntux402/shared";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Baked into @inco/lightning's Lib.sol. Verified live before deploying. */
export const INCO_SINGLETON = "0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624" as const;

export const INCO_FEE_ABI = [
  {
    type: "function",
    name: "getFee",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/**
 * Reads the ABI straight out of the Foundry artifact rather than a checked-in
 * copy, so it cannot drift from the contract that was actually compiled.
 *
 * The services use the generated `policyVaultAbi` from `@ntux402/shared`, which
 * `pnpm sync:abi --check` pins to this same artifact. Operator scripts read the
 * artifact directly because they always run beside a fresh `forge build`.
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
