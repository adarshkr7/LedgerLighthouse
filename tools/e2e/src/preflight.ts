/**
 * Checks everything M2b needs *before* it sends a transaction: right chain,
 * Inco live, keys valid, wallet funded, artifact built.
 *
 *   pnpm --filter @ntux402/e2e run preflight
 */

import { createPublicClient, formatEther } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { rpcTransport } from "@ntux402/shared/viem";

import {
  BASE_SEPOLIA_CHAIN_ID,
  INCO_SINGLETON,
  USDC_BASE_SEPOLIA,
  loadDotEnv,
  policyVaultAbi,
  required,
  requiredHexKey,
} from "./config.js";

loadDotEnv();

const problems: string[] = [];
const notes: string[] = [];

function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label.padEnd(34)} ${detail}`);
  if (!ok) problems.push(`${label}: ${detail}`);
}

console.log("\nM2b preflight\n");

// --- artifact -------------------------------------------------------------
try {
  const abi = policyVaultAbi();
  const fns = abi.filter((x) => x.type === "function").length;
  check("Foundry artifact", true, `PolicyVault.json, ${fns} functions`);
} catch (e) {
  check("Foundry artifact", false, e instanceof Error ? e.message : String(e));
}

// --- credentials ----------------------------------------------------------
let rpcUrl = "";
try {
  rpcUrl = required("BASE_SEPOLIA_RPC_URL");
  check("BASE_SEPOLIA_RPC_URL", true, rpcUrl.replace(/\/[A-Za-z0-9_-]{16,}$/, "/<redacted>"));
} catch (e) {
  check("BASE_SEPOLIA_RPC_URL", false, e instanceof Error ? e.message : String(e));
}

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
  const client = createPublicClient({ chain: baseSepolia, transport: rpcTransport(rpcUrl) });

  try {
    const chainId = await client.getChainId();
    check("chain id", chainId === BASE_SEPOLIA_CHAIN_ID, `${chainId} (want ${BASE_SEPOLIA_CHAIN_ID})`);

    const incoCode = await client.getCode({ address: INCO_SINGLETON });
    check("Inco singleton deployed", (incoCode?.length ?? 0) > 2, INCO_SINGLETON);

    const fee = await client.readContract({
      address: INCO_SINGLETON,
      abi: [{ type: "function", name: "getFee", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }],
      functionName: "getFee",
    });
    check("Inco fee", true, `${fee} wei (${formatEther(fee)} ETH) per encrypted input`);

    const usdcCode = await client.getCode({ address: USDC_BASE_SEPOLIA });
    check("USDC deployed", (usdcCode?.length ?? 0) > 2, USDC_BASE_SEPOLIA);

    if (deployer) {
      const balance = await client.getBalance({ address: deployer.address });
      // Deploy + openGoal + requestSpend + finalizeDecision, plus Inco fee.
      const enough = balance >= 3_000_000_000_000_000n; // 0.003 ETH
      check(
        "deployer funded",
        enough,
        `${formatEther(balance)} ETH${enough ? "" : " — need ~0.003 ETH; faucet: https://www.alchemy.com/faucets/base-sepolia"}`,
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
