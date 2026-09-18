// x402 resource server renting GPU time by the prepaid job. Speaks x402 v1 only.
// Phase 1 of docs/GPU_RENTAL_PLAN.md.
export * from "./handler.js";
export * from "./server.js";
export * from "./gateway.js";
export * from "./request.js";
export * from "./providers/index.js";

import { loadDotEnv, optional, required, requiredAddress, SpendLedger } from "@ntux402/shared/node";
import {
  ASSUMED_ON,
  COST_BASIS,
  GPU_BLOCK_MINUTES,
  GPU_SKUS,
  GPU_WORKLOAD_NAMES,
  assertPayoutAddress,
  formatUsdc,
  quoteAtomic,
} from "@ntux402/shared";

import { HttpFacilitatorGateway } from "./gateway.js";
import { SimulatedGpuProvider } from "./providers/index.js";
import { startVendorApi } from "./server.js";

// `pnpm --filter @ntux402/vendor-gpu start`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  loadDotEnv();
  const port = Number(process.env["VENDOR_GPU_PORT"] ?? 4023);

  const facilitatorUrl = optional("X402_FACILITATOR_URL");
  const gateway = facilitatorUrl ? new HttpFacilitatorGateway(facilitatorUrl) : undefined;

  /*
   * The ceiling, sized for hardware and not for search.
   *
   * Plan §5.6 asks for exactly this move: the search vendor's cap is 1.00 USD
   * per hour, which is less than a single hour of the cheapest card here and
   * would refuse the first rental. 25.00 per hour is roughly seven hours of an
   * H100 or two days of a 4090 — far above anything a demo does, and far below
   * what a compromised caller could otherwise run up before anyone noticed.
   *
   * It is the control that keeps the assumed costs in `gpu-skus.ts` from being
   * dangerous: the ledger counts money, so a card that costs four times what
   * the table thinks runs out of ceiling rather than out of balance.
   */
  const ledger = new SpendLedger({
    capAtomic: optional("VENDOR_GPU_SPEND_CAP_ATOMIC") ?? "25000000",
    // Persisted, so restarting is not a way past the ceiling.
    path: optional("VENDOR_GPU_LEDGER_PATH") ?? ".vendor-gpu/ledger.json",
  });

  /*
   * No provider has been chosen — plan §8 question 1 — so the adapter behind
   * this is a stand-in that allocates nothing. Everything in front of it is
   * real: the prices, the ceiling, the ordering, the 402 and the settlement.
   *
   * `GPU_PROVIDER_KEY` is read here and refused, never ignored. A key set
   * against a simulated provider is somebody expecting real hardware, and the
   * failure they should get is at boot rather than in a job result that says
   * `simulated: true` in a field nobody read.
   */
  if (optional("GPU_PROVIDER_KEY") !== undefined) {
    console.error(
      "GPU_PROVIDER_KEY is set, but no real provider adapter exists yet " +
        "(docs/GPU_RENTAL_PLAN.md §8 q1). Unset it, or wire the adapter first.",
    );
    process.exit(1);
  }

  const provider = new SimulatedGpuProvider({
    provisionMs: Number(optional("VENDOR_GPU_PROVISION_MS") ?? 30_000),
    // 0 by default: a demo that waits out the block it bought teaches nothing
    // that the clock does not already say.
    timeScale: Number(optional("VENDOR_GPU_TIME_SCALE") ?? 0),
  });

  const started = await startVendorApi(port, {
    provider,
    payTo: assertPayoutAddress("VENDOR_GPU_PAYEE", requiredAddress("VENDOR_GPU_PAYEE")),
    asset: requiredAddress("USDC_ADDRESS"),
    baseUrl: optional("VENDOR_GPU_PUBLIC_URL") ?? `http://127.0.0.1:${port}`,
    ...(gateway ? { gateway } : {}),
    ledger,
  });

  console.log(`vendor-gpu (x402 v1) listening on ${started.url}`);
  console.log(
    facilitatorUrl
      ? `  settlement: LIVE via ${facilitatorUrl}`
      : "  settlement: STUB (X402_FACILITATOR_URL unset — no USDC moves)",
  );
  console.log(`  provider  : ${provider.name} — NO REAL HARDWARE IS ALLOCATED`);
  console.log(`  spend cap : ${formatUsdc(BigInt(ledger.capAtomic))} USD / hour`);
  console.log(`  costs     : ${COST_BASIS} (written ${ASSUMED_ON})`);
  console.log(`  workloads : ${GPU_WORKLOAD_NAMES.join(", ")}`);
  for (const sku of Object.values(GPU_SKUS)) {
    const prices = GPU_BLOCK_MINUTES.map(
      (m) => `${m}m ${formatUsdc(BigInt(quoteAtomic(sku, m)))}`,
    ).join("  ");
    console.log(`  ${sku.name.padEnd(10)} ${sku.label.padEnd(11)} ${prices}`);
  }
  console.log(`  GET ${started.url}/catalog   prices, unpaid`);
  console.log(
    `  GET ${started.url}/resource/gpu?sku=rtx4090&minutes=15&workload=gpu-burn`,
  );
  // Said out loud because "simulated provider" reads like "safe to point at
  // anything", and the settlement half of that is not simulated at all.
  console.log("  note: with a facilitator configured, settlement moves real USDC.");
}
