/**
 * Non-negotiable #2 (ARCHITECTURE.md): a request carrying any terms field
 * is **rejected by schema validation**, not accepted-and-ignored.
 *
 * These tests are the reason that sentence is true. If someone later "helpfully"
 * adds an `amount` passthrough, this file fails first.
 */

import { describe, expect, it } from "vitest";

import { parseSignRequest } from "./schema.js";

describe("parseSignRequest", () => {
  it("accepts exactly (goalId, seq)", () => {
    const result = parseSignRequest({ goalId: "1", seq: "3" });
    expect(result).toEqual({ ok: true, value: { goalId: 1n, seq: 3n } });
  });

  it("accepts integers as well as decimal strings", () => {
    expect(parseSignRequest({ goalId: 7, seq: 1 })).toEqual({
      ok: true,
      value: { goalId: 7n, seq: 1n },
    });
  });

  // The headline test. Each of these is a way a caller might try to become the
  // source of truth for something the chain already froze.
  it.each([
    ["amount", { goalId: "1", seq: "1", amount: "999999999" }],
    ["value", { goalId: "1", seq: "1", value: "1" }],
    ["payTo", { goalId: "1", seq: "1", payTo: "0x2222222222222222222222222222222222222222" }],
    ["to", { goalId: "1", seq: "1", to: "0x2222222222222222222222222222222222222222" }],
    ["asset", { goalId: "1", seq: "1", asset: "0x0000000000000000000000000000000000000bad" }],
    ["validBefore", { goalId: "1", seq: "1", validBefore: "99999999999" }],
    ["nonce", { goalId: "1", seq: "1", nonce: `0x${"11".repeat(32)}` }],
    ["termsHash", { goalId: "1", seq: "1", termsHash: `0x${"22".repeat(32)}` }],
    ["chainId", { goalId: "1", seq: "1", chainId: 1 }],
  ])("rejects a request carrying %s", (field, body) => {
    const result = parseSignRequest(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("payment terms");
    expect(result.error).toContain(field);
  });

  it("rejects a terms field even when its value is null or empty", () => {
    // "It's not really supplying terms, it's empty" is exactly the reasoning
    // that turns a hard boundary into a soft one.
    expect(parseSignRequest({ goalId: "1", seq: "1", amount: null }).ok).toBe(false);
    expect(parseSignRequest({ goalId: "1", seq: "1", payTo: "" }).ok).toBe(false);
  });

  it("rejects unknown fields that are not terms", () => {
    const result = parseSignRequest({ goalId: "1", seq: "1", debug: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unknown field");
  });

  it.each([
    ["missing goalId", { seq: "1" }],
    ["missing seq", { goalId: "1" }],
    ["seq zero", { goalId: "1", seq: "0" }],
    ["negative", { goalId: -1, seq: 1 }],
    ["float", { goalId: 1.5, seq: 1 }],
    ["hex string", { goalId: "0x01", seq: "1" }],
    ["whitespace", { goalId: " 1", seq: "1" }],
    ["null body", null],
    ["array body", []],
    ["string body", "1,2"],
  ])("rejects %s", (_label, body) => {
    expect(parseSignRequest(body).ok).toBe(false);
  });

  it("rejects a seq above uint64", () => {
    expect(parseSignRequest({ goalId: "1", seq: (2n ** 64n).toString() }).ok).toBe(false);
  });
});
