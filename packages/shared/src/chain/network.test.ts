import { describe, expect, it } from "vitest";

import { NETWORKS, networkForChainId, networkNamed } from "./network.js";

describe("networks", () => {
  it("defaults to Base Sepolia, so real money is never the default", () => {
    expect(networkNamed(undefined).name).toBe("base-sepolia");
    expect(networkNamed("").name).toBe("base-sepolia");
    expect(networkNamed(undefined).testnet).toBe(true);
  });

  it("marks Base as the real-money network", () => {
    expect(networkNamed("base").testnet).toBe(false);
    expect(networkNamed("base").chainId).toBe(8453);
  });

  it("refuses a network it does not know", () => {
    expect(() => networkNamed("base-mainnet")).toThrow(/not a known network/);
  });

  /*
   * The field that differs for a reason nobody would guess. Read from each
   * token's own name() on 27 September 2026. Signing mainnet authorizations
   * with the testnet name produces signatures USDC rejects.
   */
  it("carries each USDC's own EIP-712 name", () => {
    expect(NETWORKS["base-sepolia"].usdc.eip712Name).toBe("USDC");
    expect(NETWORKS.base.usdc.eip712Name).toBe("USD Coin");
  });

  it("finds a network by chain id", () => {
    expect(networkForChainId(8453)?.name).toBe("base");
    expect(networkForChainId(84532)?.name).toBe("base-sepolia");
    expect(networkForChainId(1)).toBeUndefined();
  });
});
