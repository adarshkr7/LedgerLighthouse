import { afterEach, describe, expect, it } from "vitest";

import { networkFromEnv } from "./network-env.js";

const KEYS = ["NETWORK", "CHAIN_ID", "USDC_ADDRESS", "RPC_URL", "BASE_SEPOLIA_RPC_URL"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function env(values: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("networkFromEnv", () => {
  it("derives chain, USDC and RPC from NETWORK alone", () => {
    env({ NETWORK: "base" });
    const { network, usdcAddress, rpcUrl } = networkFromEnv();
    expect(network.chainId).toBe(8453);
    expect(usdcAddress).toBe(network.usdc.address);
    expect(rpcUrl).toContain("mainnet.base.org");
  });

  it("keeps an existing Base Sepolia .env working", () => {
    env({ BASE_SEPOLIA_RPC_URL: "https://rpc.example" });
    expect(networkFromEnv().rpcUrl).toBe("https://rpc.example");
  });

  /* A testnet RPC must never be picked up for mainnet just because it is set. */
  it("does not use BASE_SEPOLIA_RPC_URL on Base", () => {
    env({ NETWORK: "base", BASE_SEPOLIA_RPC_URL: "https://sepolia.example" });
    expect(networkFromEnv().rpcUrl).not.toContain("sepolia.example");
  });

  it("refuses a CHAIN_ID from another network", () => {
    env({ NETWORK: "base", CHAIN_ID: "84532" });
    expect(() => networkFromEnv()).toThrow(/does not match NETWORK=base/);
  });

  it("refuses a USDC_ADDRESS from another network", () => {
    env({ NETWORK: "base", USDC_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" });
    expect(() => networkFromEnv()).toThrow(/is not Base USDC/);
  });

  it("accepts CHAIN_ID and USDC_ADDRESS that agree", () => {
    env({ NETWORK: "base-sepolia", CHAIN_ID: "84532", USDC_ADDRESS: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" });
    expect(networkFromEnv().network.name).toBe("base-sepolia");
  });
});
