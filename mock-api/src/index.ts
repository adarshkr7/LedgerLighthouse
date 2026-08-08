// x402-priced mock endpoint, honest and malicious modes. Speaks x402 v1 only.
export * from "./config.js";
export * from "./handler.js";
export * from "./server.js";

import { startMockApi } from "./server.js";

// `pnpm --filter @ntux402/mock-api start`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const port = Number(process.env["MOCK_API_PORT"] ?? 4021);
  const started = await startMockApi(port);
  console.log(`mock-api (x402 v1) listening on ${started.url}`);
  console.log(`  GET ${started.url}/resource/honest`);
  console.log(`  GET ${started.url}/resource/malicious`);
}
