// x402-priced mock endpoint, honest and malicious modes. Speaks x402 v1 only.
export * from "./config.js";
export * from "./handler.js";
export * from "./server.js";
export * from "./gateway.js";

import { loadDotEnv, optional } from "@ntux402/shared/node";

import { HttpFacilitatorGateway } from "./gateway.js";
import { startMockApi } from "./server.js";

// `pnpm --filter @ntux402/mock-api start`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  loadDotEnv();
  const port = Number(process.env["MOCK_API_PORT"] ?? 4021);

  // Wired to a facilitator, payments settle for real on Base Sepolia. Without
  // one the server still validates the payload but moves no money, and says so
  // in every response.
  const facilitatorUrl = optional("X402_FACILITATOR_URL");
  const gateway = facilitatorUrl ? new HttpFacilitatorGateway(facilitatorUrl) : undefined;

  const started = await startMockApi(port, gateway ? { gateway } : {});
  console.log(`mock-api (x402 v1) listening on ${started.url}`);
  console.log(
    facilitatorUrl
      ? `  settlement: LIVE via ${facilitatorUrl}`
      : "  settlement: STUB (X402_FACILITATOR_URL unset — no money moves)",
  );
  console.log(`  GET ${started.url}/resource/honest`);
  console.log(`  GET ${started.url}/resource/malicious`);
}
