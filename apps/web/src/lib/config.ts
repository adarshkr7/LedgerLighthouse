/**
 * Wallet and service wiring for the demo UI.
 *
 * Chain is pinned to Base Sepolia and re-asserted before every write. MetaMask
 * caches a stale `chainId` after a manual network change (brief §5.5), so
 * trusting connection-time state is how you write to the wrong chain.
 */

import { http, createConfig } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const CHAIN = baseSepolia;
export const CHAIN_ID = baseSepolia.id; // 84532

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors: [injected()],
  transports: { [baseSepolia.id]: http() },
});

const env = import.meta.env;

export const ORCHESTRATOR_URL: string =
  (env["VITE_ORCHESTRATOR_URL"] as string | undefined) ?? "http://127.0.0.1:8404";

export interface OrchestratorConfig {
  readonly vaultAddress: `0x${string}`;
  readonly usdcAddress: `0x${string}`;
  readonly chainId: number;
  readonly relayAddress: `0x${string}`;
  readonly signerUrl: string;
  readonly mockApiUrl: string;
  /** "stub" means payloads are validated but no money moves. Shown, never hidden. */
  readonly settlement: "live" | "stub";
  readonly agent: "llm" | "scripted";
}

export async function fetchOrchestratorConfig(): Promise<OrchestratorConfig> {
  const response = await fetch(`${ORCHESTRATOR_URL}/config`);
  if (!response.ok) {
    throw new Error(`orchestrator /config returned ${response.status}`);
  }
  return (await response.json()) as OrchestratorConfig;
}

/** 6-decimal USDC, for display only. */
/**
 * Atomic USDC as a decimal string, always with at least two places.
 *
 * Trailing zeros beyond the second are dropped, so 0.125 keeps its precision
 * while 0.30 does not collapse to "0.3". Trimming all of them made a column of
 * amounts ragged — "0.3" next to "4.00" next to "0.01" — and read as sloppy
 * rather than as money.
 */
export function formatUsdc(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const trimmed = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${trimmed.padEnd(2, "0")}`;
}

export function truncate(hex: string, lead = 10, tail = 8): string {
  return hex.length <= lead + tail + 1 ? hex : `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

export const explorer = {
  address: (a: string) => `https://sepolia.basescan.org/address/${a}`,
  tx: (h: string) => `https://sepolia.basescan.org/tx/${h}`,
};
