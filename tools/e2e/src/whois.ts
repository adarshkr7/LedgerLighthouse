/**
 * Balances for arbitrary addresses.
 *
 *   pnpm --filter @ntux402/e2e run whois 0xabc... [0xdef...]
 *
 * `balances` covers the three configured roles; this is for anything else —
 * a MetaMask account, a payer address, a faucet destination.
 */
import { createPublicClient, formatEther, isAddress, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { rpcTransport } from "@ntux402/shared/viem";
import { formatUsdc, usdcAbi } from "@ntux402/shared";

import { loadDotEnv, required, requiredAddress } from "./config.js";

loadDotEnv();

const targets = process.argv.slice(2).filter((a) => isAddress(a)) as Address[];
if (targets.length === 0) {
  console.error("usage: whois <address> [address...]");
  process.exit(2);
}

const usdc = requiredAddress("USDC_ADDRESS");
const client = createPublicClient({ chain: baseSepolia, transport: rpcTransport(required("BASE_SEPOLIA_RPC_URL")) });

console.log("\nBase Sepolia\n");
for (const address of targets) {
  const [eth, balance, code] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
    client.getCode({ address }),
  ]);
  console.log(`  ${address}`);
  console.log(`    ${formatEther(eth).padStart(22)} ETH`);
  console.log(`    ${formatUsdc(balance).padStart(22)} USDC`);
  // A delegated EOA (EIP-7702) reports code; worth surfacing, since it changes
  // how some tooling treats the account.
  if (code && code.length > 2) console.log(`    code present (${code.length - 2} hex chars) — delegated/smart account`);
  console.log();
}
