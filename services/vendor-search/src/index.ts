// x402 resource server fronting a paid live-search API. Speaks x402 v1 only.
export * from "./handler.js";
export * from "./server.js";
export * from "./gateway.js";
export * from "./query.js";
export * from "./upstream.js";

import {
  loadDotEnv,
  optional,
  required,
  requiredAddress,
} from "@ntux402/shared/node";
import { SEARCH_TIERS, VERIFIED_ON, assertPayoutAddress, formatUsdc } from "@ntux402/shared";

import { HttpFacilitatorGateway } from "./gateway.js";
import { startVendorApi } from "./server.js";
import { GatewaySearch, SpendLedger } from "./upstream.js";

// `pnpm --filter @ntux402/vendor-search start`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  loadDotEnv();
  const port = Number(process.env["VENDOR_SEARCH_PORT"] ?? 4022);

  /*
   * `SEARCH_VENDOR_KEY` and nothing else. It is deliberately *not* falling back to
   * `LLM_API_KEY`: the whole point of two names is that the orchestrator
   * holds one of them and this service holds the other, and a fallback would
   * quietly collapse that back into a single credential the moment someone
   * forgot to set one. See README.md.
   */
  const apiKey = required("SEARCH_VENDOR_KEY");

  const facilitatorUrl = optional("X402_FACILITATOR_URL");
  const gateway = facilitatorUrl ? new HttpFacilitatorGateway(facilitatorUrl) : undefined;

  // Denominated in USDC atomic units, which are also micros USD — the unit
  // providers report cost in. Default 1.00 USD per hour: far above what the demo needs
  // and far below what a compromised caller could otherwise spend.
  const ledger = new SpendLedger({
    capAtomic: optional("VENDOR_SEARCH_SPEND_CAP_ATOMIC") ?? "1000000",
    // Persisted, so restarting is not a way past the ceiling. Beside the trace
    // store because both are run records the operator keeps and git ignores.
    path: optional("VENDOR_SEARCH_LEDGER_PATH") ?? ".vendor-search/ledger.json",
  });

  const started = await startVendorApi(port, {
    upstream: new GatewaySearch({
      apiKey,
      // Required, with no default: naming one provider here is the thing this
      // service stopped doing, and a stale default fails at the first paid call
      // instead of at boot.
      baseUrl: required("SEARCH_API_BASE_URL"),
      // Optional. Absent means the provider reports no per-call cost and the
      // quoted price stands unreconciled — which the trace records as such.
      costHeader: optional("SEARCH_COST_HEADER"),
    }),
    payTo: assertPayoutAddress("VENDOR_SEARCH_PAYEE", requiredAddress("VENDOR_SEARCH_PAYEE")),
    asset: requiredAddress("USDC_ADDRESS"),
    baseUrl: optional("VENDOR_SEARCH_PUBLIC_URL") ?? `http://127.0.0.1:${port}`,
    ...(gateway ? { gateway } : {}),
    ledger,
  });

  console.log(`vendor-search (x402 v1) listening on ${started.url}`);
  console.log(
    facilitatorUrl
      ? `  settlement: LIVE via ${facilitatorUrl}`
      : "  settlement: STUB (X402_FACILITATOR_URL unset — no USDC moves)",
  );
  console.log(`  spend cap : ${formatUsdc(BigInt(ledger.capAtomic))} USD / hour`);
  console.log(`  prices verified ${VERIFIED_ON}`);
  for (const tier of Object.values(SEARCH_TIERS)) {
    console.log(
      `  GET ${started.url}/resource/search?q=...&tier=${tier.name}` +
        `   ${formatUsdc(BigInt(tier.priceAtomic))} USDC`,
    );
  }
  // Said out loud because "stub settlement" reads like "nothing is spent", and
  // for this service that is not true: the upstream call is always real.
  console.log(`  note: every served request calls the upstream API for real, stub mode included.`);
}
