/**
 *   pnpm --filter @ntux402/facilitator run start
 *
 * Needs FACILITATOR_PRIVATE_KEY (gas only — it holds no user funds) and a
 * little ETH on the network NETWORK names. Set X402_FACILITATOR_URL to this server's address so
 * the resource server finds it.
 */

import {
  bindHost,
  createLogger,
  describeGuard,
  loadDotEnv,
  networkFromEnv,
  requiredHexKey,
} from "@ntux402/shared/node";
import { createPublicClient, formatEther, isAddress } from "viem";

import { AuthCaptureFacilitator } from "./auth-capture.js";
import { Facilitator } from "./facilitator.js";
import { createFacilitatorServer } from "./http.js";
import { rpcTransport, viemChain } from "@ntux402/shared/viem";

loadDotEnv();

const log = createLogger("facilitator");

const port = Number(process.env["FACILITATOR_PORT"] ?? 8403);
const { network, rpcUrl, usdcAddress } = networkFromEnv();

const facilitator = new Facilitator({
  rpcUrl,
  chainId: network.chainId,
  asset: usdcAddress,
  network: network.x402Network,
  settlerKey: requiredHexKey("FACILITATOR_PRIVATE_KEY"),
});

/**
 * The vaults whose escrowed payments this relays, comma separated. Off when unset: an
 * operator is a contract this facilitator spends gas calling, so none is trusted by
 * default.
 */
const escrowOperators = (process.env["FACILITATOR_ESCROW_OPERATORS"] ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");
for (const operator of escrowOperators) {
  if (!isAddress(operator)) throw new Error(`FACILITATOR_ESCROW_OPERATORS: ${operator} is not an address`);
}

const authCapture =
  escrowOperators.length === 0
    ? undefined
    : new AuthCaptureFacilitator({
        rpcUrl,
        chainId: network.chainId,
        asset: usdcAddress,
        settlerKey: requiredHexKey("FACILITATOR_PRIVATE_KEY"),
        operators: escrowOperators as `0x${string}`[],
      });

const server = createFacilitatorServer({
  facilitator,
  network: network.x402Network,
  ...(authCapture ? { authCapture } : {}),
  log: (line) => log.info(line),
});

const client = createPublicClient({ chain: viemChain(network), transport: rpcTransport(rpcUrl) });

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
  log.info("settler", { address: facilitator.settlerAddress, network: network.label });
});

void client.getBalance({ address: facilitator.settlerAddress }).then(
  (balance) => {
    log.info("gas balance", { eth: formatEther(balance) });
    if (balance < 500_000_000_000_000n) {
      log.warn(
        network.testnet
          ? "low gas balance — settlement will fail. Faucet: https://www.alchemy.com/faucets/base-sepolia"
          : `low gas balance — settlement will fail. Send a little ETH on ${network.label} to the settler.`,
      );
    }
  },
  (error: unknown) => {
    log.warn("could not read gas balance from the RPC; serving anyway", {
      detail: error instanceof Error ? error.message.split("\n")[0] : String(error),
    });
  },
);
