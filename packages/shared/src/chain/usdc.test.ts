import { describe, expect, it } from "vitest";

import { USDC_BASE_SEPOLIA, assertPayoutAddress } from "./usdc.js";
import type { Address } from "../x402/protocol.js";

describe("assertPayoutAddress", () => {
  it("accepts an ordinary wallet address", () => {
    const wallet = "0x25e0a349480f32A474bdf24c1c7956c2F919e825" as Address;
    expect(assertPayoutAddress("VENDOR_SEARCH_PAYEE", wallet)).toBe(wallet);
  });

  /*
   * The likely mistake, because USDC_ADDRESS is already in .env and is the only
   * USDC-shaped address most people have to hand. Nothing downstream would
   * catch it: the transfer succeeds, settlement reports success, the trace
   * records a genuine payment, and the money is gone.
   */
  it("rejects the USDC token contract, in either case", () => {
    expect(() => assertPayoutAddress("VENDOR_SEARCH_PAYEE", USDC_BASE_SEPOLIA)).toThrow(
      /USDC token contract/,
    );
    expect(() =>
      assertPayoutAddress("VENDOR_SEARCH_PAYEE", USDC_BASE_SEPOLIA.toLowerCase() as Address),
    ).toThrow(/USDC token contract/);
  });

  it("rejects the zero address", () => {
    const zero = "0x0000000000000000000000000000000000000000" as Address;
    expect(() => assertPayoutAddress("VENDOR_SEARCH_PAYEE", zero)).toThrow(/burned/);
  });

  it("names the offending variable so the message is actionable", () => {
    expect(() => assertPayoutAddress("SOME_PAYEE", USDC_BASE_SEPOLIA)).toThrow(/SOME_PAYEE/);
  });
});
