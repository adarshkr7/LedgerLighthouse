import {
  NETWORK_BASE_SEPOLIA,
  SCHEME_EXACT,
  USDC_BASE_SEPOLIA,
  X402_VERSION,
} from "@ntux402/shared";

/*
 * Prices, payees and descriptions live in `@ntux402/shared`'s demo catalog, not
 * here. The orchestrator routes to those paths and the console lists those
 * prices, so a copy in this package is a copy that will eventually disagree.
 */
export {
  DEMO_GOALS,
  // The subset this server actually owns. The catalog also carries live goals
  // served by services/vendor-aisa, and answering for those here would hand
  // back a fixture at a price the console displayed for real data.
  MOCK_GOALS,
  isMockGoal,
  HONEST_DESCRIPTION,
  INJECTION_TEXT,
  descriptionFor,
  findDemoGoal,
  type DemoGoal,
} from "@ntux402/shared";

export interface ServerConfig {
  readonly network: string;
  readonly asset: string;
  readonly maxTimeoutSeconds: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  network: NETWORK_BASE_SEPOLIA,
  asset: USDC_BASE_SEPOLIA,
  maxTimeoutSeconds: 60,
};

export { SCHEME_EXACT, X402_VERSION };
