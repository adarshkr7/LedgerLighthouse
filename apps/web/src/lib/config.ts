/**
 * Wallet and service wiring for the demo UI.
 *
 * Chain is pinned at build time by VITE_NETWORK (Base Sepolia when unset) and
 * re-asserted before every write. MetaMask caches a stale `chainId` after a
 * manual network change (ARCHITECTURE.md), so trusting connection-time state
 * is how you write to the wrong chain.
 */

import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { networkNamed, rpcUrls } from "@ntux402/shared";
import { rpcTransport, viemChain } from "@ntux402/shared/viem";

const env = import.meta.env;

/**
 * Build-time, because wagmi's config is built once at module load. The
 * orchestrator's own chain is checked against it in `fetchOrchestratorConfig`,
 * so a console built for one network cannot drive services on another.
 */
export const NETWORK = networkNamed(env["VITE_NETWORK"] as string | undefined);
export const CHAIN = viemChain(NETWORK);
export const CHAIN_ID = CHAIN.id;

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
  (env["VITE_RPC_URL"] as string | undefined) ?? NETWORK.defaultRpcUrls.join(",");

/** For SDKs that want the list rather than a transport — Inco's, in particular. */
export const RPC_URLS: readonly string[] = rpcUrls(RPC_URL);

export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: [injected()],
  transports: { [CHAIN.id]: rpcTransport(RPC_URL) },
});

export const ORCHESTRATOR_URL: string =
  (env["VITE_ORCHESTRATOR_URL"] as string | undefined) ?? "http://127.0.0.1:8404";

/**
 * The one payee a goal opened here allowlists, and the address the mock vendor is paid
 * at. Build-time, like the network, and deliberately not from the orchestrator: the
 * allowlist bounds where a compromised orchestrator can send money, so it cannot be the
 * one to name it.
 */
export function vendorAddress(): `0x${string}` {
  const vendor = env["VITE_VENDOR_ADDRESS"] as string | undefined;
  if (vendor === undefined || !/^0x[0-9a-fA-F]{40}$/.test(vendor)) {
    throw new Error("VITE_VENDOR_ADDRESS is not set to an address. Set it to the vendor's address and rebuild.");
  }
  return vendor as `0x${string}`;
}

/**
 * The vault a goal is opened on. Build-time for the same reason as the vendor: the
 * orchestrator is the party this system assumes compromised, and a user who opened a goal
 * on a vault it named would be trusting that vault's every check.
 */
function pinnedVault(): `0x${string}` {
  const vault = env["VITE_POLICY_VAULT_ADDRESS"] as string | undefined;
  if (vault === undefined || !/^0x[0-9a-fA-F]{40}$/.test(vault)) {
    throw new Error("VITE_POLICY_VAULT_ADDRESS is not set to an address. Set it to the vault's address and rebuild.");
  }
  return vault as `0x${string}`;
}

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
  /** The model that read the vendor's text. Absent when the agent is scripted. */
  readonly agentModel?: string | undefined;
}

export async function fetchOrchestratorConfig(): Promise<OrchestratorConfig> {
  const response = await fetch(`${ORCHESTRATOR_URL}/config`);
  if (!response.ok) {
    throw new Error(`orchestrator /config returned ${response.status}`);
  }
  const config = (await response.json()) as OrchestratorConfig;
  if (config.chainId !== CHAIN_ID) {
    throw new Error(
      `the orchestrator is on chain ${config.chainId}, but this console was built for ` +
        `${NETWORK.label} (${CHAIN_ID}). Set VITE_NETWORK to match NETWORK and rebuild.`,
    );
  }
  const vault = pinnedVault();
  if (config.vaultAddress.toLowerCase() !== vault.toLowerCase()) {
    throw new Error(`the orchestrator names vault ${config.vaultAddress}, but this console was built for ${vault}.`);
  }
  if (config.usdcAddress.toLowerCase() !== NETWORK.usdc.address.toLowerCase()) {
    throw new Error(`the orchestrator names token ${config.usdcAddress}, which is not ${NETWORK.label} USDC.`);
  }
  return config;
}

/**
 * Whether Inco can reveal a decision right now, as the orchestrator last saw it.
 *
 * A run cannot finish without that, so the console pauses Buy while it is
 * unavailable instead of letting a run commit and then wait on stage.
 */
export type IncoHealth =
  | { readonly status: "ready"; readonly latencyMs: number; readonly checkedAt: number }
  | { readonly status: "unavailable"; readonly detail: string; readonly checkedAt: number }
  | { readonly status: "unchecked" };

export async function fetchIncoHealth(): Promise<IncoHealth> {
  const response = await fetch(`${ORCHESTRATOR_URL}/health/inco`);
  if (!response.ok) throw new Error(`orchestrator /health/inco returned ${response.status}`);
  return (await response.json()) as IncoHealth;
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
  address: (a: string) => `${NETWORK.explorer}/address/${a}`,
  tx: (h: string) => `${NETWORK.explorer}/tx/${h}`,
};
