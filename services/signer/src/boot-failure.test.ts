import { describe, expect, it } from "vitest";

import { hintFor, summarize } from "./boot-failure.js";

describe("summarize", () => {
  it("keeps the first line only", () => {
    expect(summarize(new Error("first\nsecond"))).toBe("first");
  });

  // /health is public through the ROFL proxy, and RPC URLs carry API keys in the path.
  it("cuts the path and query off URLs", () => {
    const detail = summarize(new Error("HTTP request failed. URL: https://base-sepolia.g.alchemy.com/v2/SECRETKEY?x=1"));
    expect(detail).toBe("HTTP request failed. URL: https://base-sepolia.g.alchemy.com/…");
    expect(detail).not.toContain("SECRETKEY");
  });
});

describe("hintFor", () => {
  // The failure behind the first v2 deployment's crash loop on 9 October 2026.
  it("names the socket permission problem", () => {
    const detail =
      "rofl-appd unreachable at /run/rofl-appd.sock: connect EACCES /run/rofl-appd.sock. This store only works inside a deployed ROFL container";
    expect(hintFor("key index rebuild", detail)).toMatch(/cannot open the enclave key daemon's socket/);
  });

  it("names a missing socket", () => {
    const detail = "rofl-appd unreachable at /run/rofl-appd.sock: connect ENOENT /run/rofl-appd.sock";
    expect(hintFor("key index rebuild", detail)).toMatch(/not there/);
  });

  it("names a vault without the payer binding", () => {
    expect(hintFor("key index rebuild", 'The contract function "payerGoal" reverted.')).toMatch(/predates the payer binding/);
  });

  it("names an RPC that did not answer", () => {
    expect(hintFor("key index rebuild", "HTTP request failed.")).toMatch(/RPC did not answer/);
  });

  it("points configuration errors at the setting", () => {
    expect(hintFor("configuration", "Missing POLICY_VAULT_ADDRESS.")).toMatch(/setting/);
  });

  it("says nothing it does not know", () => {
    expect(hintFor("key store", "something new")).toBeUndefined();
  });
});
