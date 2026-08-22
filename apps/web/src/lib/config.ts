/**
 * Wallet and service wiring for the demo UI.
 *
 * Chain is pinned to Base Sepolia and re-asserted before every write. MetaMask
 * caches a stale `chainId` after a manual network change (IMPLEMENTATION.md §5.2), so
 * trusting connection-time state is how you write to the wrong chain.
 */

import { createConfig } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { rpcUrls } from "@ntux402/shared";
import { rpcTransport } from "@ntux402/shared/viem";

export const CHAIN = baseSepolia;
export const CHAIN_ID = baseSepolia.id; // 84532

const env = import.meta.env;

/**
 * RPC endpoints for the browser.
 *
 * This used to be a bare `http()`, which resolves to the chain's default public
 * endpoint — and every service meanwhile read a configured list. The gap only
 * shows under load: `sepolia.base.org` answers some methods while returning
 * `-32011 no backend is currently healthy` for `eth_call`, so the console fails
 * on a contract read while the backend, pointed elsewhere, is perfectly fine.
 *
 * Comma-separated, and more than one entry builds a viem `fallback` — the same
 * transport `@ntux402/shared/viem` gives the services. The default keeps the
 * chain's own endpoint as a second choice rather than the only one.
 */
export const RPC_URL: string =
  (env["VITE_RPC_URL"] as string | undefined) ??
  "https://base-sepolia-rpc.publicnode.com,https://sepolia.base.org";

/** For SDKs that want the list rather than a transport — Inco's, in particular. */
export const RPC_URLS: readonly string[] = rpcUrls(RPC_URL);

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors: [injected()],
  transports: { [baseSepolia.id]: rpcTransport(RPC_URL) },
});

export const ORCHESTRATOR_URL: string =
  (env["VITE_ORCHESTRATOR_URL"] as string | undefined) ?? "http://127.0.0.1:8404";

export interface OrchestratorConfig {
  readonly vaultAddress: `0x${string}`;
  readonly usdcAddress: `0x${string}`;
  readonly chainId: number;
  readonly relayAddress: `0x${string}`;
  readonly signerUrl: string;
  readonly mockApiUrl: string;
  /** Live-search vendor. Absent when it is not configured — the picker greys those goals out. */
  readonly vendorAisaUrl?: string | undefined;
  /**
   * The live vendor's payee, which is **not** in the shared catalog.
   *
   * It is the operator's own address, so it cannot be compiled into this
   * bundle. It has to be unioned into the allowlist when a goal is opened, or
   * every live spend reverts `PayeeNotAllowlisted` — the correct failure, and a
   * thoroughly confusing one to watch.
   */
  readonly vendorAisaPayee?: `0x${string}` | undefined;
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
