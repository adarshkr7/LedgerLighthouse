// x402-priced mock endpoint, honest and malicious modes. Speaks x402 v1 only.
export * from "./config.js";
export * from "./handler.js";
export * from "./server.js";
export * from "./gateway.js";
export * from "./escrow.js";
export * from "./escrow-gateway.js";

import {
  loadDotEnv,
  networkFromEnv,
  optional,
  requiredAddress,
  requiredHexKey,
} from "@ntux402/shared/node";

import { DEFAULT_CONFIG } from "./config.js";
import type { EscrowVendorOptions } from "./escrow.js";
import { ChainEscrowGateway } from "./escrow-gateway.js";
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

  /*
   * Selling through the escrow needs what the v1 flow does not: a key, because the vendor
   * sends `claim` itself, and a real facilitator, because a stubbed hold is no hold.
   */
  const settlement = process.env["SIGNER_SETTLEMENT"];
  let escrow: EscrowVendorOptions | undefined;
  if (settlement === "escrow") {
    if (!gateway) {
      console.error("mock-api: SIGNER_SETTLEMENT=escrow needs X402_FACILITATOR_URL.");
      process.exit(1);
    }
    const { rpcUrl } = networkFromEnv();
    const chainGateway = new ChainEscrowGateway({
      facilitator: gateway,
      rpcUrl,
      chainId: network.chainId,
      vault: requiredAddress("POLICY_VAULT_ADDRESS"),
      vendorKey: requiredHexKey("VENDOR_PRIVATE_KEY"),
    });
    escrow = {
      vault: requiredAddress("POLICY_VAULT_ADDRESS"),
      vendor: chainGateway.vendor,
      network: `eip155:${network.chainId}`,
      asset: usdcAddress,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      gateway: chainGateway,
    };
  }

  const started = await startMockApi(port, {
    config,
    ...(gateway ? { gateway } : {}),
    ...(escrow ? { escrow } : {}),
  });
  console.log(`mock-api (x402 ${escrow ? "v2 auth-capture" : "v1"}) listening on ${started.url}  [${network.label}]`);
  console.log(
    escrow
      ? `  settlement: ESCROW via ${facilitatorUrl}, vendor ${escrow.vendor}, vault ${escrow.vault}`
      : facilitatorUrl
        ? `  settlement: LIVE via ${facilitatorUrl}`
        : "  settlement: STUB (X402_FACILITATOR_URL unset — no money moves)",
  );
  console.log(`  GET ${started.url}/resource/honest`);
  console.log(`  GET ${started.url}/resource/malicious`);
}
