import { describe, expect, it } from "vitest";

import { SEARCH_TIERS } from "@ntux402/shared";

import { MAX_QUERY_LENGTH, validateQuery, validateTier } from "./query.js";

describe("validateQuery", () => {
  it("accepts an ordinary query and trims it", () => {
    const result = validateQuery("  base sepolia usdc  ");
    expect(result.ok && result.value).toBe("base sepolia usdc");
  });

  it("rejects a non-string, an empty string, and whitespace only", () => {
    for (const bad of [undefined, null, 42, {}, "", "   "]) {
      expect(validateQuery(bad).ok).toBe(false);
    }
  });

  it("rejects rather than truncates an over-long query", () => {
    const long = "a".repeat(MAX_QUERY_LENGTH + 1);
    const result = validateQuery(long);
    expect(result.ok).toBe(false);
    // Truncating would mean searching for something other than what was asked
    // for, and the query is hashed into termsHash.
    expect(!result.ok && result.error).toContain("exceeds");
  });

  it("accepts a query of exactly the limit", () => {
    expect(validateQuery("a".repeat(MAX_QUERY_LENGTH)).ok).toBe(true);
  });

  it("rejects control characters instead of stripping them", () => {
    const newline = `usdc${String.fromCharCode(10)}price`;
    const nul = `usdc${String.fromCharCode(0)}`;
    const del = `usdc${String.fromCharCode(127)}`;
    for (const bad of [newline, nul, del]) {
      const result = validateQuery(bad);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain("control characters");
    }
  });

  it("keeps ordinary punctuation and non-ASCII text", () => {
    expect(validateQuery('what is "x402"? — 2026').ok).toBe(true);
    expect(validateQuery("東京 の 天気").ok).toBe(true);
  });
});

describe("validateTier", () => {
  it("defaults to basic when unspecified", () => {
    const result = validateTier(undefined);
    expect(result.ok && result.value.name).toBe("basic");
  });

  it("resolves the named tiers", () => {
    expect(validateTier("deep").ok && SEARCH_TIERS.deep.searchDepth).toBe("advanced");
  });

  it("rejects an unknown tier rather than falling back", () => {
    // A silent fallback would let a caller ask for a tier that does not exist
    // and be billed for one that does.
    const result = validateTier("free");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("unknown tier");
  });
});
