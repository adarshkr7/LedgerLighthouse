import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SpendLedger } from "./spend-ledger.js";

describe("SpendLedger", () => {
  it("permits spending up to the cap and refuses past it", () => {
    const ledger = new SpendLedger({ capAtomic: "20000" });
    expect(ledger.wouldExceed("10000")).toBe(false);
    ledger.record("8000", "10000");
    expect(ledger.wouldExceed("10000")).toBe(false);
    ledger.record("8000", "10000");
    // 16000 spent; another 10000 would breach 20000.
    expect(ledger.wouldExceed("10000")).toBe(true);
  });

  /*
   * An unreported cost counts at the quoted price. Treating it as zero would
   * make a missing header the cheapest way past the ceiling.
   */
  it("charges the quoted price when the real cost is unknown", () => {
    const ledger = new SpendLedger({ capAtomic: "20000" });
    ledger.record(undefined, "10000");
    expect(ledger.spentAtomic).toBe("10000");
  });

  it("resets when the window rolls over", () => {
    let now = 0;
    const ledger = new SpendLedger({ capAtomic: "10000", windowMs: 1000, now: () => now });
    ledger.record("10000", "10000");
    expect(ledger.wouldExceed("1")).toBe(true);

    now = 1001;
    expect(ledger.wouldExceed("1")).toBe(false);
    expect(ledger.spentAtomic).toBe("0");
  });
});

describe("SpendLedger persistence", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "ll-ledger-")), "ledger.json");

  /*
   * The loophole this closes: an in-memory ceiling makes restarting the
   * cheapest way past it, and a service that crash-loops under load does that
   * to itself. Unbounded spend against a real balance, with nobody doing
   * anything wrong.
   */
  it("survives a restart", () => {
    const path = tmp();
    const first = new SpendLedger({ capAtomic: "20000", path });
    first.record("16000", "20000");
    expect(first.wouldExceed("10000")).toBe(true);

    const reopened = new SpendLedger({ capAtomic: "20000", path });
    expect(reopened.spentAtomic).toBe("16000");
    expect(reopened.wouldExceed("10000")).toBe(true);
  });

  it("carries the window across, so a restart does not extend it", () => {
    const path = tmp();
    let now = 1_000_000;
    const first = new SpendLedger({ capAtomic: "10000", windowMs: 1000, path, now: () => now });
    first.record("10000", "10000");

    // Past the window: the reopened ledger must roll, not resume.
    now = 1_002_000;
    const reopened = new SpendLedger({ capAtomic: "10000", windowMs: 1000, path, now: () => now });
    expect(reopened.wouldExceed("1")).toBe(false);
    expect(reopened.spentAtomic).toBe("0");
  });

  it("starts fresh rather than refusing when the file is unreadable", () => {
    const path = tmp();
    writeFileSync(path, "{ not json");
    const ledger = new SpendLedger({ capAtomic: "20000", path });
    // A ledger that cannot be read is a reason to be careful, not to stop
    // selling — the provider-side spending cap is the backstop.
    expect(ledger.spentAtomic).toBe("0");
  });

  it("ignores a ledger whose window starts in the future", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ spentAtomic: "9999", windowStart: Date.now() + 86_400_000 }));
    // A clock change, not a ledger. Honouring it would suppress the ceiling.
    expect(new SpendLedger({ capAtomic: "20000", path }).spentAtomic).toBe("0");
  });

  it("ignores a malformed amount", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ spentAtomic: 9999, windowStart: Date.now() - 10 }));
    expect(new SpendLedger({ capAtomic: "20000", path }).spentAtomic).toBe("0");
  });
});
