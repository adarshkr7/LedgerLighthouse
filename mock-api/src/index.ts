// x402-priced mock endpoint, honest and malicious modes. Speaks x402 v1 only.
export * from "./config.js";
export * from "./handler.js";
export * from "./server.js";
export * from "./gateway.js";

import { loadDotEnv, networkFromEnv, optional } from "@ntux402/shared/node";

import { DEFAULT_CONFIG } from "./config.js";
import { HttpFacilitatorGateway } from "./gateway.js";
import { startMockApi } from "./server.js";

// `pnpm --filter @ntux402/mock-api start`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  loadDotEnv();
  const port = Number(process.env["MOCK_API_PORT"] ?? 4021);

  // Wired to a facilitator, payments settle for real on the configured network.
  // Without one the server still validates the payload but moves no money, and
  // says so in every response.
  const facilitatorUrl = optional("X402_FACILITATOR_URL");
  const { network, usdcAddress } = networkFromEnv();

  /*
   * The demo payees are placeholder addresses (0x1111…1111 and kin) that nobody
   * holds a key for. On a testnet that is harmless. On mainnet every settled
   * purchase would send real USDC somewhere it can never be spent from, so
   * live settlement there is refused rather than allowed with a warning.
   */
  if (!network.testnet && facilitatorUrl) {
    console.error(
      `mock-api refuses live settlement on ${network.label}: its payees are placeholder ` +
        "addresses nobody controls, so every purchase would burn real USDC. Unset " +
        "X402_FACILITATOR_URL to run it stubbed, or buy from a real vendor.",
    );
    process.exit(1);
  }

  const gateway = facilitatorUrl ? new HttpFacilitatorGateway(facilitatorUrl) : undefined;
  const config = { ...DEFAULT_CONFIG, network: network.x402Network, asset: usdcAddress };

  const started = await startMockApi(port, gateway ? { gateway, config } : { config });
  console.log(`mock-api (x402 v1) listening on ${started.url}  [${network.label}]`);
  console.log(
    facilitatorUrl
      ? `  settlement: LIVE via ${facilitatorUrl}`
      : "  settlement: STUB (X402_FACILITATOR_URL unset — no money moves)",
  );
  console.log(`  GET ${started.url}/resource/honest`);
  console.log(`  GET ${started.url}/resource/malicious`);
}
