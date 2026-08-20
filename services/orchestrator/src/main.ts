/**
 * Runs the payment loop against a live goal.
 *
 *   pnpm --filter @ntux402/orchestrator run start -- --goal 6 --url http://127.0.0.1:4021/resource/honest
 *
 * Needs a goal already opened with this process's relay address as its relay,
 * and the signer running with the key for that goal's payer. `tools/e2e run
 * demo` sets all of that up; this entry point is for driving one request at a
 * time while debugging.
 *
 * Holds the **relay key** and no other. If you ever find yourself wanting a
 * payer key here, the design has drifted (IMPLEMENTATION.md §7).
 */

import { loadDotEnv, optional, required, requiredAddress, requiredHexKey } from "@ntux402/shared/node";
import { formatUsdc, rpcUrls } from "@ntux402/shared";
import { Lightning } from "@inco/lightning-js/lite";

import { X402Client } from "./x402/client.js";
import { IncoDecisionReader } from "./inco/reveal.js";
import { PaymentLoop } from "./pay/payment-loop.js";
import { VaultRelay } from "./pay/relay.js";
import { SignerClient } from "./pay/signer-client.js";
import { ScriptedAgent } from "./agent/scripted.js";
import { buildAgent } from "./agent/factory.js";
import { renderEvent } from "./render.js";

loadDotEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const goalId = BigInt(arg("goal") ?? required("DEMO_GOAL_ID"));
const url = arg("url") ?? `http://127.0.0.1:${process.env["MOCK_API_PORT"] ?? 4021}/resource/honest`;
const rpcUrl = required("BASE_SEPOLIA_RPC_URL");

const relay = new VaultRelay({
  rpcUrl,
  vaultAddress: requiredAddress("POLICY_VAULT_ADDRESS"),
  relayKey: requiredHexKey("ORCHESTRATOR_RELAY_KEY"),
  chainId: Number(process.env["CHAIN_ID"] ?? 84532),
});

const zap = await Lightning.baseSepoliaTestnet({ hostChainRpcUrls: [...rpcUrls(rpcUrl)] });

const agent = await buildAgent({
  apiKey: optional("LLM_API_KEY"),
  model: optional("LLM_MODEL"),
  fallback: new ScriptedAgent(),
});

const loop = new PaymentLoop({
  client: new X402Client(),
  relay,
  decisions: new IncoDecisionReader(zap),
  signer: new SignerClient(optional("SIGNER_URL") ?? `http://127.0.0.1:${process.env["SIGNER_PORT"] ?? 8402}`),
  agent,
  asset: requiredAddress("USDC_ADDRESS"),
  onEvent: (event) => console.log(renderEvent(event)),
});

console.log(`\norchestrator — goal ${goalId}`);
console.log(`  relay   ${relay.relayAddress}  (gas only)`);
console.log(`  target  ${url}\n`);

const result = await loop.fetchPaid(url, goalId);

console.log("\n--- result ---------------------------------------------------");
switch (result.kind) {
  case "free":
    console.log("  200 without payment");
    break;
  case "paid":
    console.log(`  PAID  ${formatUsdc(result.terms.amount)} USDC -> ${result.terms.payTo}`);
    console.log(`  tx    ${result.settlement?.transaction ?? "(stub settlement — no money moved)"}`);
    break;
  case "policy-rejected":
    console.log(`  BOUNCED  the confidential policy rejected (${result.goalId}, ${result.seq})`);
    console.log(`  handle   ${result.decisionHandle}`);
    console.log(`  commit   ${result.commitTx}`);
    console.log("  Counters unchanged. No authorization exists to sign against.");
    break;
  case "decision-unavailable":
    console.log(
      `  DECISION UNAVAILABLE after ${result.attempts} attempts / ${Math.round(result.elapsedMs / 1000)}s.`,
    );
    console.log("  The debit committed at requestSpend. This is the [INCO] liveness case,");
    console.log("  not a rejection — see ARCHITECTURE.md §7.7.");
    break;
  case "failed":
    console.log(`  FAILED  ${result.reason}`);
    break;
}
console.log("--------------------------------------------------------------\n");

process.exit(result.kind === "failed" ? 1 : 0);
