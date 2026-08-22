import { describe, expect, it } from "vitest";

import { asSearchPayload, hostOf, safeHref, vendorUpstreamOf } from "./search-result.js";

describe("safeHref", () => {
  it("passes ordinary http and https links through", () => {
    expect(safeHref("https://example.test/a?b=c")).toBe("https://example.test/a?b=c");
    expect(safeHref("http://example.test/")).toBe("http://example.test/");
  });

  /*
   * The reason this function exists. A result title linked to `javascript:`
   * would be one click from running script in the console's own origin, beside
   * a connected wallet.
   */
  it("refuses script-bearing and non-network schemes", () => {
    const hostile = [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.test/abc",
    ];
    for (const raw of hostile) {
      expect(safeHref(raw), raw).toBeUndefined();
    }
  });

  it("drops a relative or unparseable href rather than resolving it", () => {
    // Resolving against our own origin would turn a vendor's malformed link
    // into a link to us — the wrong repair, not a safer one.
    for (const raw of ["/admin", "../x", "not a url", "", undefined]) {
      expect(safeHref(raw)).toBeUndefined();
    }
  });

  it("ignores a non-string", () => {
    expect(safeHref(42 as unknown as string)).toBeUndefined();
    expect(safeHref(null as unknown as string)).toBeUndefined();
  });
});

describe("hostOf", () => {
  it("reduces a URL to its host", () => {
    expect(hostOf("https://docs.example.test/a/b")).toBe("docs.example.test");
    expect(hostOf("http://example.test:8080/")).toBe("example.test:8080");
  });
});

describe("asSearchPayload", () => {
  it("accepts a body carrying results or an answer", () => {
    expect(asSearchPayload({ data: { results: [] } })).toBeDefined();
    expect(asSearchPayload({ data: { answer: "because" } })).toBeDefined();
  });

  /*
   * The mock vendor's 200 body is a fabricated price tick. Rendering it through
   * the results panel would put a fixture where real purchased data goes.
   */
  it("rejects the mock vendor's payload shape", () => {
    const mockBody = {
      resource: "https://mock/resource/market-data",
      mode: "market-data",
      data: { symbol: "ETH/USD", price: "3421.55", premium: true },
    };
    expect(asSearchPayload(mockBody)).toBeUndefined();
  });

  it("rejects non-objects and empty shapes", () => {
    for (const bad of [undefined, null, 42, "text", [], {}, { data: {} }]) {
      expect(asSearchPayload(bad)).toBeUndefined();
    }
  });
});

describe("vendorUpstreamOf", () => {
  it("extracts what the vendor reported", () => {
    const payload = {
      upstream: {
        requestId: "req-1",
        latencyMs: 3600,
        costAtomic: "8000",
        quotedAtomic: "10000",
      },
    };
    expect(vendorUpstreamOf(payload)).toEqual({
      requestId: "req-1",
      latencyMs: 3600,
      costAtomic: "8000",
      quotedAtomic: "10000",
    });
  });

  /*
   * Amounts stay strings all the way into the hash. A number here would mean an
   * atomic value had been through a float on its way into the trace.
   */
  it("refuses an amount that is not a decimal string", () => {
    for (const bad of [8000, "8.0", "0x1f40", "-1", "", null]) {
      const result = vendorUpstreamOf({ upstream: { costAtomic: bad, requestId: "r" } });
      expect(result?.costAtomic, String(bad)).toBeUndefined();
    }
  });

  it("keeps the fields it can read and drops the ones it cannot", () => {
    const result = vendorUpstreamOf({
      upstream: { requestId: "r", latencyMs: "soon", costAtomic: "8000" },
    });
    expect(result).toEqual({ requestId: "r", costAtomic: "8000" });
  });

  it("returns nothing for a payload without an upstream block", () => {
    // The mock vendor's body, which must not produce a vendor-upstream step.
    expect(vendorUpstreamOf({ mode: "market-data", data: { price: "3421.55" } })).toBeUndefined();
    for (const bad of [undefined, null, 42, "text", {}, { upstream: null }, { upstream: {} }]) {
      expect(vendorUpstreamOf(bad)).toBeUndefined();
    }
  });
});
