/**
 * Runs the orchestrator as a service for the web UI.
 *
 *   pnpm --filter @ntux402/orchestrator run serve
 *
 * Holds the relay key. Never the payer key — that lives in the signer, and the
 * boundary check exists to keep it that way.
 */

import { loadDotEnv, optional, required, requiredAddress, requiredHexKey } from "@ntux402/shared/node";
import { Lightning } from "@inco/lightning-js/lite";

import { X402Client } from "./x402/client.js";
import { IncoDecisionReader } from "./inco/reveal.js";
import { PaymentLoop } from "./pay/payment-loop.js";
import { VaultRelay } from "./pay/relay.js";
import { SignerClient } from "./pay/signer-client.js";
import { ScriptedAgent } from "./agent/scripted.js";
import { buildAgent } from "./agent/factory.js";
import { createOrchestratorServer } from "./server.js";
import { renderEvent } from "./render.js";

loadDotEnv();

const port = Number(process.env["ORCHESTRATOR_PORT"] ?? 8404);
const chainId = Number(process.env["CHAIN_ID"] ?? 84532);
const rpcUrl = required("BASE_SEPOLIA_RPC_URL");
const vaultAddress = requiredAddress("POLICY_VAULT_ADDRESS");
const usdcAddress = requiredAddress("USDC_ADDRESS");
const signerUrl = optional("SIGNER_URL") ?? `http://127.0.0.1:${process.env["SIGNER_PORT"] ?? 8402}`;
const mockApiUrl = optional("MOCK_API_URL") ?? `http://127.0.0.1:${process.env["MOCK_API_PORT"] ?? 4021}`;

const relay = new VaultRelay({
  rpcUrl,
  vaultAddress,
  relayKey: requiredHexKey("ORCHESTRATOR_RELAY_KEY"),
  chainId,
});

const zap = await Lightning.baseSepoliaTestnet({ hostChainRpcUrls: [rpcUrl] });

const apiKey = optional("LLM_API_KEY") ?? process.env["ANTHROPIC_API_KEY"];
const agent = await buildAgent({
  apiKey,
  model: optional("LLM_MODEL"),
  fallback: new ScriptedAgent(),
});

const loop = new PaymentLoop({
  client: new X402Client(),
  relay,
  decisions: new IncoDecisionReader(zap),
  signer: new SignerClient(signerUrl),
  agent,
  asset: usdcAddress,
  onEvent: (event) => console.log(renderEvent(event)),
});

const server = createOrchestratorServer({
  loop,
  relay,
  vaultAddress,
  usdcAddress,
  chainId,
  mockApiUrl,
  signerUrl,
  facilitatorUrl: optional("X402_FACILITATOR_URL"),
  agentSource: apiKey ? "llm" : "scripted",
  log: (line) => console.log(`[orchestrator] ${line}`),
});

server.listen(port, () => {
  console.log(`[orchestrator] listening on http://127.0.0.1:${port}`);
  console.log(`[orchestrator] relay ${relay.relayAddress}  (gas only)`);
  console.log(`[orchestrator] agent ${apiKey ? "live LLM" : "scripted stand-in"}`);
  console.log(
    `[orchestrator] settlement ${optional("X402_FACILITATOR_URL") ? "live" : "STUB — no money moves"}`,
  );
});
