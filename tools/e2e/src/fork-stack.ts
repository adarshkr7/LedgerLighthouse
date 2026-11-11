/**
 * The real contracts and services, on a local fork of Base Sepolia, with fresh keys.
 * Used by escrow-flow.ts and fork-tools.ts. Every transaction goes to the fork.
 *
 * Real: EscrowPolicyVault, Inco's on-chain contract, the deployed escrow, collector and
 * USDC, the signer, the facilitator with @x402/evm and the vendor, each over HTTP.
 *
 * Not real: Inco's off-chain evaluation. A fork has no covalidators, so whoever runs on
 * this supplies the decisions, and ForkVerifier accepts an attestation that is merely
 * bound to its handle and value. So nothing on a fork says anything about the encrypted
 * limits, or that a decision was earned.
 */

import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { AuthCaptureFacilitator, Facilitator, createFacilitatorServer } from "@ntux402/facilitator";
import {
  ChainEscrowGateway,
  HttpFacilitatorGateway,
  startMockApi,
  type EscrowGateway,
  type EscrowVendorOptions,
} from "@ntux402/mock-api";
import { SignerClient } from "@ntux402/orchestrator";
import { AUTH_CAPTURE_ESCROW, ERC3009_TOKEN_COLLECTOR, USDC_BASE_SEPOLIA, escrowPolicyVaultAbi } from "@ntux402/shared";
import { OnChainVaultReader, createSignerServer, inMemoryKeyStore, openSigner } from "@ntux402/signer";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const CHAIN_ID = 84532;
export const USDC = USDC_BASE_SEPOLIA as Address;
export const INCO: Address = "0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624";
/** Holds test USDC on the forked chain. */
const HOLDER: Address = "0x1111111111111111111111111111111111111111";

const erc20 = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const incoAbi = parseAbi(["function incoVerifier() view returns (address)", "function getFee() view returns (uint256)"]);

function artifact(path: string): { abi: Abi; bytecode: { object: Hex } } {
  const file = fileURLToPath(new URL(`../../../contracts/out/${path}`, import.meta.url));
  return JSON.parse(readFileSync(file, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
}

async function listening(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface FundedKey {
  readonly key: Hex;
  readonly account: PrivateKeyAccount;
}

export interface ForkStack {
  readonly rpc: string;
  readonly chain: Chain;
  readonly pub: PublicClient;
  readonly request: (method: string, params: unknown[]) => Promise<unknown>;
  readonly user: FundedKey;
  readonly relay: FundedKey;
  readonly settler: FundedKey;
  readonly vault: Address;
  readonly deployBlock: bigint;
  readonly userWallet: WalletClient<Transport, Chain, PrivateKeyAccount>;
  readonly signer: SignerClient;
  readonly signerUrl: string;
  readonly facilitatorUrl: string;
  readonly gateway: ChainEscrowGateway;
  readonly vendor: Awaited<ReturnType<typeof startMockApi>>;
  readonly vendorAddress: Address;
  readonly vendorOptions: (gateway: EscrowGateway) => EscrowVendorOptions;
  readonly sendUsdc: (to: Address, amount: bigint) => Promise<void>;
  readonly balance: (who: Address) => Promise<bigint>;
  readonly incoFee: () => Promise<bigint>;
  readonly vaultAbi: typeof escrowPolicyVaultAbi;
  readonly close: () => Promise<void>;
  /** What a script run as a separate process needs to find all of the above. */
  readonly env: Readonly<Record<string, string>>;
}

export async function startForkStack(rpc: string): Promise<ForkStack> {
  const chain: Chain = { ...baseSepolia, rpcUrls: { default: { http: [rpc] } } };
  const pub = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  const request = (method: string, params: unknown[]): Promise<unknown> => pub.request({ method, params } as never);

  // A fork pinned to an older block starts with that block's clock, while the vendor's
  // hold and the payment loop's deadlines come from the wall clock. Move the fork's
  // clock to now, so the two agree as they do on the live network.
  const head = await pub.getBlock();
  const wall = BigInt(Math.floor(Date.now() / 1000));
  if (head.timestamp < wall - 30n) {
    await request("evm_setNextBlockTimestamp", [toHex(wall)]);
    await request("evm_mine", []);
  }

  const funded = async () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    await request("anvil_setBalance", [account.address, toHex(10n ** 18n)]);
    return { key, account };
  };
  const user = await funded();
  const relay = await funded();
  const settler = await funded();
  const vendorKey = await funded();
  const userWallet: ForkStack["userWallet"] = createWalletClient({ chain, transport: http(rpc), account: user.account });

  const deploy = async (name: string, args: readonly unknown[]): Promise<Address> => {
    const { abi, bytecode } = artifact(name);
    const hash = await userWallet.deployContract({ abi, bytecode: bytecode.object, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  };

  // The original code moves aside, and ForkVerifier takes its address and calls back into it.
  const verifier = await pub.readContract({ address: INCO, abi: incoAbi, functionName: "incoVerifier" });
  const originalCode = privateKeyToAccount(generatePrivateKey()).address;
  await request("anvil_setCode", [originalCode, await pub.getCode({ address: verifier })]);
  const shim = await deploy("ForkVerifier.sol/ForkVerifier.json", [originalCode]);
  await request("anvil_setCode", [verifier, await pub.getCode({ address: shim })]);

  // The enrollment key does not depend on the vault, so it is read before the vault
  // that pins it exists, from the same seed the signer then uses.
  const seed = generatePrivateKey();
  const enrollmentSigner = (await inMemoryKeyStore({ chainId: CHAIN_ID, vault: ZERO_ADDRESS }, seed).enrollment()).address;
  const vault = await deploy("EscrowPolicyVault.sol/EscrowPolicyVault.json", [
    AUTH_CAPTURE_ESCROW,
    ERC3009_TOKEN_COLLECTOR,
    enrollmentSigner,
  ]);
  const deployBlock = await pub.getBlockNumber();
  console.log(`  Inco's verifier ${verifier} replaced with ForkVerifier: this run does not test decisions`);
  console.log(`  EscrowPolicyVault ${vault}`);

  const keys = inMemoryKeyStore({ chainId: CHAIN_ID, vault }, seed);
  const signerServer = createSignerServer({
    signer: await openSigner({
      vault: new OnChainVaultReader({ rpcUrl: rpc, vaultAddress: vault, chainId: CHAIN_ID }),
      keys,
      chainId: CHAIN_ID,
      usdcAddress: USDC,
      vaultAddress: vault,
    }),
    binding: { chainId: CHAIN_ID, vault, settlement: "escrow" },
  });
  const signerUrl = await listening(signerServer);

  const facilitatorServer = createFacilitatorServer({
    facilitator: new Facilitator({
      rpcUrl: rpc,
      chainId: CHAIN_ID,
      asset: USDC,
      network: "base-sepolia",
      settlerKey: settler.key,
    }),
    network: "base-sepolia",
    authCapture: new AuthCaptureFacilitator({
      rpcUrl: rpc,
      chainId: CHAIN_ID,
      asset: USDC,
      settlerKey: settler.key,
      operators: [vault],
    }),
  });
  const facilitatorUrl = await listening(facilitatorServer);

  const gateway = new ChainEscrowGateway({
    facilitator: new HttpFacilitatorGateway(facilitatorUrl),
    rpcUrl: rpc,
    chainId: CHAIN_ID,
    vault,
    vendorKey: vendorKey.key,
  });
  const vendorAddress = gateway.vendor;
  const vendorOptions = (g: EscrowGateway): EscrowVendorOptions => ({
    vault,
    vendor: vendorAddress,
    network: `eip155:${CHAIN_ID}`,
    asset: USDC,
    maxTimeoutSeconds: 60,
    gateway: g,
  });
  const vendor = await startMockApi(0, { escrow: vendorOptions(gateway) });

  /** Test USDC, from an account that holds some on the forked chain. */
  const sendUsdc = async (to: Address, amount: bigint): Promise<void> => {
    await request("anvil_impersonateAccount", [HOLDER]);
    await request("anvil_setBalance", [HOLDER, toHex(10n ** 18n)]);
    const holder = createWalletClient({ chain, transport: http(rpc), account: HOLDER });
    await pub.waitForTransactionReceipt({
      hash: await holder.writeContract({ address: USDC, abi: erc20, functionName: "transfer", args: [to, amount] }),
    });
  };

  return {
    rpc,
    chain,
    pub,
    request,
    user,
    relay,
    settler,
    vault,
    deployBlock,
    userWallet,
    signer: new SignerClient(signerUrl),
    signerUrl,
    facilitatorUrl,
    gateway,
    vendor,
    vendorAddress,
    vendorOptions,
    sendUsdc,
    balance: (who: Address) => pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [who] }),
    incoFee: () => pub.readContract({ address: INCO, abi: incoAbi, functionName: "getFee" }),
    vaultAbi: escrowPolicyVaultAbi,
    close: async () => {
      await vendor.close();
      for (const server of [signerServer, facilitatorServer]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
    /** What a script run as a separate process needs to find all of the above. */
    env: {
      NETWORK: "base-sepolia",
      RPC_URL: rpc,
      POLICY_VAULT_ADDRESS: vault,
      DEPLOYER_PRIVATE_KEY: user.key,
      ORCHESTRATOR_RELAY_KEY: relay.key,
      SIGNER_URL: signerUrl,
      MOCK_API_URL: vendor.url,
      X402_FACILITATOR_URL: facilitatorUrl,
      FORK_DECISIONS_FROM_BLOCK: deployBlock.toString(),
      // Empty stops loadDotEnv filling these in from the operator's own .env.
      SIGNER_SERVICE_TOKEN: "",
      SERVICE_TOKEN: "",
      LLM_API_KEY: "",
      LLM_MODEL: "",
      LLM_BASE_URL: "",
      CHAIN_ID: "",
      USDC_ADDRESS: "",
      BASE_SEPOLIA_RPC_URL: "",
    },
  };
}
