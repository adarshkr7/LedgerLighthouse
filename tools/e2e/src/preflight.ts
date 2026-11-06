/**
 * Checks everything a run needs *before* it sends a transaction: right chain,
 * Inco able to reveal decisions, keys valid, wallet funded, artifact built.
 * Run it before a demo; it sends nothing and costs nothing.
 *
 *   pnpm --filter @ntux402/e2e run preflight
 */

import { createPublicClient, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { rpcTransport, viemChain } from "@ntux402/shared/viem";
import { AUTH_CAPTURE_ESCROW, ERC3009_TOKEN_COLLECTOR, NETWORKS, type Network } from "@ntux402/shared";
import { IncoDecisionReader, IncoHealthProbe, connectLightning } from "@ntux402/orchestrator";

import {
  INCO_SINGLETON,
  loadDotEnv,
  networkFromEnv,
  optional,
  requiredHexKey,
  vaultAbi,
} from "./config.js";

loadDotEnv();

const problems: string[] = [];
const notes: string[] = [];

function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label.padEnd(34)} ${detail}`);
  if (!ok) problems.push(`${label}: ${detail}`);
}

console.log("\npreflight\n");

// --- artifact -------------------------------------------------------------
try {
  const abi = vaultAbi();
  const fns = abi.filter((x) => x.type === "function").length;
  check("Foundry artifact", true, `EscrowPolicyVault.json, ${fns} functions`);
} catch (e) {
  check("Foundry artifact", false, e instanceof Error ? e.message : String(e));
}

// --- network --------------------------------------------------------------
// Falls back to Base Sepolia only so the remaining checks can still run and
// report; a NETWORK the loader refused is already a failure above them.
let network: Network = NETWORKS["base-sepolia"];
let rpcUrl = "";
try {
  ({ network, rpcUrl } = networkFromEnv());
  check("NETWORK", true, `${network.label} (chain ${network.chainId})${network.testnet ? "" : " — REAL MONEY"}`);
  check("RPC", true, rpcUrl.replace(/\/[A-Za-z0-9_-]{16,}$/, "/<redacted>"));
} catch (e) {
  check("NETWORK", false, e instanceof Error ? e.message : String(e));
}

// --- credentials ----------------------------------------------------------

let deployer: ReturnType<typeof privateKeyToAccount> | undefined;
try {
  deployer = privateKeyToAccount(requiredHexKey("DEPLOYER_PRIVATE_KEY"));
  check("DEPLOYER_PRIVATE_KEY", true, `-> ${deployer.address}`);

  // This loader tolerates a missing 0x; `vm.envUint` in Foundry does not.
  // Passing here while `forge script` fails with "missing hex prefix" is a
  // genuinely confusing hour, so fail rather than paper over it.
  const raw = process.env["DEPLOYER_PRIVATE_KEY"] ?? "";
  check(
    "key has 0x prefix",
    raw.startsWith("0x"),
    raw.startsWith("0x")
      ? "forge vm.envUint will parse it"
      : "MISSING — forge will fail with 'missing hex prefix'. Note a shell env var overrides .env.",
  );
} catch (e) {
  check("DEPLOYER_PRIVATE_KEY", false, e instanceof Error ? e.message : String(e));
}

if (process.env["BASESCAN_API_KEY"]) {
  check("BASESCAN_API_KEY", true, "set (needed only for --verify)");
} else {
  notes.push("BASESCAN_API_KEY unset — deploy will work, Basescan verification will not.");
}

// --- chain ----------------------------------------------------------------
if (rpcUrl) {
  const client = createPublicClient({ chain: viemChain(network), transport: rpcTransport(rpcUrl) });

  try {
    const chainId = await client.getChainId();
    check("chain id", chainId === network.chainId, `${chainId} (want ${network.chainId})`);

    const incoCode = await client.getCode({ address: INCO_SINGLETON });
    check("Inco singleton deployed", (incoCode?.length ?? 0) > 2, INCO_SINGLETON);

    const fee = await client.readContract({
      address: INCO_SINGLETON,
      abi: [{ type: "function", name: "getFee", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }],
      functionName: "getFee",
    });
    check("Inco fee", true, `${fee} wei (${formatEther(fee)} ETH) per encrypted input`);

    /*
     * The check that matters on the day. Every run needs Inco to reveal its
     * decision, and that needs all of Inco's covalidators up. This asks for a
     * decision already revealed on chain, so a failure here is Inco, not us.
     */
    const probeHandle = (optional("INCO_PROBE_HANDLE") as `0x${string}` | undefined) ?? network.incoProbeHandle;
    if (!probeHandle) {
      notes.push(
        `No revealed decision is known on ${network.label}, so Inco could not be probed. ` +
          "Set INCO_PROBE_HANDLE once a first run has revealed one.",
      );
    } else {
      try {
        const zap = await connectLightning(network, rpcUrl);
        const inco = await new IncoHealthProbe(new IncoDecisionReader(zap), { handle: probeHandle }).check();
        check(
          "Inco can reveal decisions",
          inco.status === "ready",
          inco.status === "ready"
            ? `answered in ${(inco.latencyMs / 1000).toFixed(1)}s`
            : `${inco.detail} — runs will stop at the confidential evaluation`,
        );
      } catch (e) {
        check("Inco can reveal decisions", false, e instanceof Error ? e.message : String(e));
      }
    }

    const usdcCode = await client.getCode({ address: network.usdc.address });
    check("USDC deployed", (usdcCode?.length ?? 0) > 2, network.usdc.address);

    const escrowCode = await client.getCode({ address: AUTH_CAPTURE_ESCROW });
    check("auth-capture escrow deployed", (escrowCode?.length ?? 0) > 2, AUTH_CAPTURE_ESCROW);
    const collectorCode = await client.getCode({ address: ERC3009_TOKEN_COLLECTOR });
    check("ERC-3009 collector deployed", (collectorCode?.length ?? 0) > 2, ERC3009_TOKEN_COLLECTOR);

    if (deployer) {
      const balance = await client.getBalance({ address: deployer.address });
      // Deploy + openGoal + requestSpend + finalizeDecision, plus Inco fee.
      const enough = balance >= 3_000_000_000_000_000n; // 0.003 ETH
      check(
        "deployer funded",
        enough,
        `${formatEther(balance)} ETH${enough ? "" : network.testnet ? " — need ~0.003 ETH; faucet: https://www.alchemy.com/faucets/base-sepolia" : ` — need ~0.003 ETH on ${network.label}`}`,
      );
    }
  } catch (e) {
    check("RPC reachable", false, e instanceof Error ? e.message : String(e));
  }
}

for (const note of notes) console.log(`\n  note: ${note}`);

if (problems.length > 0) {
  console.log(`\n${problems.length} problem(s) must be fixed before deploying.\n`);
  process.exit(1);
}
console.log("\nPreflight clean — ready to deploy.\n");
