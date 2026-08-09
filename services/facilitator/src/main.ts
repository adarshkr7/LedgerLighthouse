/**
 *   pnpm --filter @ntux402/facilitator run start
 *
 * Needs FACILITATOR_PRIVATE_KEY (gas only — it holds no user funds) and a
 * little Base Sepolia ETH. Set X402_FACILITATOR_URL to this server's address so
 * the resource server finds it.
 */

import { loadDotEnv, required, requiredAddress, requiredHexKey } from "@ntux402/shared/node";
import { NETWORK_BASE_SEPOLIA } from "@ntux402/shared";
import { createPublicClient, formatEther, http } from "viem";
import { baseSepolia } from "viem/chains";

import { Facilitator } from "./facilitator.js";
import { createFacilitatorServer } from "./http.js";

loadDotEnv();

const port = Number(process.env["FACILITATOR_PORT"] ?? 8403);
const chainId = Number(process.env["CHAIN_ID"] ?? 84532);
const rpcUrl = required("BASE_SEPOLIA_RPC_URL");

const facilitator = new Facilitator({
  rpcUrl,
  chainId,
  asset: requiredAddress("USDC_ADDRESS"),
  network: NETWORK_BASE_SEPOLIA,
  settlerKey: requiredHexKey("FACILITATOR_PRIVATE_KEY"),
});

const server = createFacilitatorServer({
  facilitator,
  network: NETWORK_BASE_SEPOLIA,
  log: (line) => console.log(`[facilitator] ${line}`),
});

const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
const balance = await client.getBalance({ address: facilitator.settlerAddress });

server.listen(port, () => {
  console.log(`[facilitator] listening on http://127.0.0.1:${port}`);
  console.log(`[facilitator] settler ${facilitator.settlerAddress}  ${formatEther(balance)} ETH (gas)`);
  if (balance < 500_000_000_000_000n) {
    console.warn(
      "[facilitator] WARNING: low gas balance. Settlement will fail. " +
        "Faucet: https://www.alchemy.com/faucets/base-sepolia",
    );
  }
});
