/**
 *   pnpm --filter @ntux402/facilitator run start
 *
 * Needs FACILITATOR_PRIVATE_KEY (gas only — it holds no user funds) and a
 * little Base Sepolia ETH. Set X402_FACILITATOR_URL to this server's address so
 * the resource server finds it.
 */

import {
  bindHost,
  createLogger,
  describeGuard,
  loadDotEnv,
  required,
  requiredAddress,
  requiredHexKey,
} from "@ntux402/shared/node";
import { NETWORK_BASE_SEPOLIA } from "@ntux402/shared";
import { createPublicClient, formatEther, http } from "viem";
import { baseSepolia } from "viem/chains";

import { Facilitator } from "./facilitator.js";
import { createFacilitatorServer } from "./http.js";
import { rpcTransport } from "@ntux402/shared/viem";

loadDotEnv();

const log = createLogger("facilitator");

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
  log: (line) => log.info(line),
});

const client = createPublicClient({ chain: baseSepolia, transport: rpcTransport(rpcUrl) });

/*
 * Listen first, read the gas balance after.
 *
 * The balance is a diagnostic: it is printed, and it warns when settlement is
 * likely to fail. It is not a precondition for serving. It used to be read at
 * the top level with `await` and no catch, one line above `listen()` — so a
 * single flaky response from the public RPC rejected at module scope, took the
 * process down before the port ever opened, and the whole demo stack lost its
 * facilitator to a transient upstream blip. `sepolia.base.org` answering
 * "no backend is currently healthy to serve traffic" is a normal Tuesday for a
 * free public endpoint, and it must not be fatal.
 *
 * So the order is inverted and the read is non-fatal. A facilitator that is up
 * but cannot say how much gas it has is strictly more useful than one that is
 * not up.
 */
server.listen(port, bindHost(), () => {
  log.info(`listening on http://${bindHost()}:${port}`, { guard: describeGuard() });
  log.info("settler", { address: facilitator.settlerAddress });
});

void client.getBalance({ address: facilitator.settlerAddress }).then(
  (balance) => {
    log.info("gas balance", { eth: formatEther(balance) });
    if (balance < 500_000_000_000_000n) {
      log.warn(
        "low gas balance — settlement will fail. " +
          "Faucet: https://www.alchemy.com/faucets/base-sepolia",
      );
    }
  },
  (error: unknown) => {
    log.warn("could not read gas balance from the RPC; serving anyway", {
      detail: error instanceof Error ? error.message.split("\n")[0] : String(error),
    });
  },
);
