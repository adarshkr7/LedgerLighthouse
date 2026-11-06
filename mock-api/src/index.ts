// x402-priced mock endpoint, honest and malicious modes. Sells through the auth-capture escrow.
export * from "./config.js";
export * from "./handler.js";
export * from "./server.js";
export * from "./gateway.js";
export * from "./escrow.js";
export * from "./escrow-gateway.js";

import {
  loadDotEnv,
  networkFromEnv,
  required,
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

  const { network, usdcAddress, rpcUrl } = networkFromEnv();

  /*
   * The demo payees are placeholder addresses nobody holds a key for, and the vendor
   * key below is a test key. On mainnet both would put real USDC at risk, so it refuses.
   */
  if (!network.testnet) {
    console.error(
      `mock-api refuses to run on ${network.label}: it is a test vendor with a test key, and every ` +
        "purchase would be real USDC. Buy from a real vendor.",
    );
    process.exit(1);
  }

  /*
   * Needs a key, because the vendor sends `claim` itself, and a real facilitator, because
   * a stubbed hold is no hold.
   */
  const facilitatorUrl = required("X402_FACILITATOR_URL");
  const vault = requiredAddress("POLICY_VAULT_ADDRESS");
  const config = { ...DEFAULT_CONFIG, network: network.x402Network, asset: usdcAddress };
  const gateway = new ChainEscrowGateway({
    facilitator: new HttpFacilitatorGateway(facilitatorUrl),
    rpcUrl,
    chainId: network.chainId,
    vault,
    vendorKey: requiredHexKey("VENDOR_PRIVATE_KEY"),
  });
  const escrow: EscrowVendorOptions = {
    vault,
    vendor: gateway.vendor,
    network: `eip155:${network.chainId}`,
    asset: usdcAddress,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    gateway,
  };

  const started = await startMockApi(port, { config, escrow });
  console.log(`mock-api (x402 v2 auth-capture) listening on ${started.url}  [${network.label}]`);
  console.log(`  settlement: ESCROW via ${facilitatorUrl}, vendor ${escrow.vendor}, vault ${escrow.vault}`);
  console.log(`  GET ${started.url}/resource/honest`);
  console.log(`  GET ${started.url}/resource/malicious`);
}
