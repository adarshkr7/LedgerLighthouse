/**
 * The published `@x402/evm` facilitator, settling through the deployed escrow and USDC
 * on a local fork, with a signature made the way the signer makes it. Nothing here
 * touches a real network, and it skips unless given a fork to run against:
 *
 *   anvil --fork-url https://sepolia.base.org --port 8599
 *   forge build --root contracts
 *   ESCROW_ANVIL_RPC=http://127.0.0.1:8599 pnpm --filter @ntux402/facilitator test
 *
 * The operator is a stand-in without the vault's checks. Those are tested in
 * contracts/test/EscrowPolicyVault.t.sol. This is about whether the SDK, our wire format
 * and our signature agree with the contracts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  AUTH_CAPTURE_ESCROW,
  ERC3009_TOKEN_COLLECTOR,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  paymentSalt,
  type AuthCapturePayload,
  type AuthCaptureRequirements,
  type PaymentInfo,
} from "@ntux402/shared";
import { escrowNonce } from "@ntux402/shared/viem";

import { AuthCaptureFacilitator } from "./auth-capture.js";

const FORK = process.env["ESCROW_ANVIL_RPC"];
/** Clients below are built when the file loads, skipped or not. They connect only when used. */
const RPC = FORK ?? "http://127.0.0.1:8599";
const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** Holds test USDC on the forked chain. */
const HOLDER: Address = "0x1111111111111111111111111111111111111111";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const AMOUNT = 100_000n;

const erc20 = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const operatorAbi = parseAbi([
  "struct PaymentInfo { address operator; address payer; address receiver; address token; uint120 maxAmount; uint48 preApprovalExpiry; uint48 authorizationExpiry; uint48 refundExpiry; uint16 minFeeBps; uint16 maxFeeBps; address feeReceiver; uint256 salt; }",
  "function capture(PaymentInfo info, uint256 amount)",
]);

describe.skipIf(!FORK)("auth-capture through the real SDK and contracts", () => {
  const chain = { ...baseSepolia, rpcUrls: { default: { http: [RPC] } } };
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const rpc = (method: string, params: unknown[]) => pub.request({ method, params } as never);
  const balance = (who: Address) =>
    pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [who] });

  const payer = privateKeyToAccount(generatePrivateKey());
  const settlerKey = generatePrivateKey();
  const settler = privateKeyToAccount(settlerKey);
  const vendor = privateKeyToAccount(generatePrivateKey()).address;
  let operator: Address;
  let facilitator: AuthCaptureFacilitator;

  /** The fields and typed data the signer produces, built from the same shared helpers. */
  async function sign(seq: bigint, overrides: { signer?: typeof payer } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const validBefore = now + 120;
    const captureDeadline = now + 420;
    const info: PaymentInfo = {
      operator,
      payer: payer.address,
      receiver: vendor,
      token: USDC,
      maxAmount: AMOUNT,
      preApprovalExpiry: validBefore,
      authorizationExpiry: captureDeadline,
      refundExpiry: captureDeadline,
      minFeeBps: 0,
      maxFeeBps: 0,
      feeReceiver: ZERO,
      salt: paymentSalt(1n, seq),
    };
    const nonce = escrowNonce(info, { escrow: AUTH_CAPTURE_ESCROW, chainId: chain.id });
    const signature = await (overrides.signer ?? payer).signTypedData({
      domain: { name: "USDC", version: "2", chainId: chain.id, verifyingContract: USDC },
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: payer.address,
        to: ERC3009_TOKEN_COLLECTOR,
        value: AMOUNT,
        validAfter: 0n,
        validBefore: BigInt(validBefore),
        nonce,
      },
    });
    const requirements: AuthCaptureRequirements = {
      scheme: "auth-capture",
      network: `eip155:${chain.id}`,
      amount: AMOUNT.toString(),
      asset: USDC,
      payTo: vendor,
      maxTimeoutSeconds: 60,
      extra: {
        name: "USDC",
        version: "2",
        authCaptureEscrow: AUTH_CAPTURE_ESCROW,
        captureAuthorizer: operator,
        operatorType: "custom",
        paymentFlow: "escrow",
        captureDeadline,
        refundDeadline: captureDeadline,
        minFeeBps: 0,
        maxFeeBps: 0,
        feeRecipient: ZERO,
        assetTransferMethod: "eip3009",
      },
    };
    const payment: AuthCapturePayload = {
      x402Version: 2,
      resource: { url: "http://mock/resource", method: "GET" },
      accepted: requirements,
      payload: {
        authorization: {
          from: payer.address,
          to: ERC3009_TOKEN_COLLECTOR,
          value: AMOUNT.toString(),
          validAfter: "0",
          validBefore: String(validBefore),
          nonce,
        },
        signature,
        salt: toHex(info.salt, { size: 32 }),
      },
    };
    return { info, requirements, payment };
  }

  beforeAll(async () => {
    await rpc("anvil_impersonateAccount", [HOLDER]);
    await rpc("anvil_setBalance", [HOLDER, toHex(10n ** 18n)]);
    await rpc("anvil_setBalance", [settler.address, toHex(10n ** 18n)]);

    const holder = createWalletClient({ chain, transport: http(RPC), account: HOLDER });
    await pub.waitForTransactionReceipt({
      hash: await holder.writeContract({
        address: USDC,
        abi: erc20,
        functionName: "transfer",
        args: [payer.address, 1_000_000n],
      }),
    });

    const artifactPath = fileURLToPath(
      new URL("../../../contracts/out/ForwardingOperator.sol/ForwardingOperator.json", import.meta.url),
    );
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      abi: never;
      bytecode: { object: Hex };
    };
    const deployer = createWalletClient({ chain, transport: http(RPC), account: settler });
    const receipt = await pub.waitForTransactionReceipt({
      hash: await deployer.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
        args: [AUTH_CAPTURE_ESCROW] as never,
      }),
    });
    operator = receipt.contractAddress!;

    facilitator = new AuthCaptureFacilitator({
      rpcUrl: RPC,
      chainId: chain.id,
      asset: USDC,
      settlerKey,
      operators: [operator],
    });
  }, 120_000);

  it("verifies, holds, and pays out only on capture", async () => {
    const before = await balance(payer.address);
    const { info, requirements, payment } = await sign(1n);

    expect(await facilitator.verify(payment, requirements)).toMatchObject({ isValid: true });

    const settled = await facilitator.settle(payment, requirements);
    expect(settled).toMatchObject({ success: true });
    expect(await balance(payer.address)).toBe(before - AMOUNT);
    expect(await balance(vendor)).toBe(0n);

    // A repeat after a lost response: reported as settled, and no money moves.
    expect(await facilitator.settle(payment, requirements)).toMatchObject({ success: true, alreadySettled: true });
    expect(await balance(payer.address)).toBe(before - AMOUNT);

    // The vendor's own call, which a facilitator never relays for a custom operator.
    const wallet = createWalletClient({ chain, transport: http(RPC), account: settler });
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: operator,
        abi: operatorAbi,
        functionName: "capture",
        args: [
          {
            ...info,
            preApprovalExpiry: info.preApprovalExpiry,
            authorizationExpiry: info.authorizationExpiry,
            refundExpiry: info.refundExpiry,
          },
          AMOUNT,
        ],
      }),
    });
    expect(await balance(vendor)).toBe(AMOUNT);
  }, 120_000);

  it("refuses a signature from anyone but the payer", async () => {
    const { requirements, payment } = await sign(2n, { signer: privateKeyToAccount(generatePrivateKey()) });
    expect(await facilitator.verify(payment, requirements)).toMatchObject({ isValid: false });
    expect(await facilitator.settle(payment, requirements)).toMatchObject({ success: false });
  }, 120_000);

  it("refuses an operator that is not allowlisted, before any chain call", async () => {
    const { requirements, payment } = await sign(3n);
    const stranger = { ...requirements, extra: { ...requirements.extra, captureAuthorizer: vendor } };
    const verdict = await facilitator.verify({ ...payment, accepted: stranger }, stranger);
    expect(verdict.isValid).toBe(false);
    expect(verdict.invalidReason).toMatch(/allowlist/);
  });
});
