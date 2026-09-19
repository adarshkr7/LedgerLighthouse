import { describe, expect, it } from "vitest";

import {
  blockRunningOut,
  describeLeaseEnding,
  formatBlockClock,
  leaseSummaryOf,
  remainingMs,
  untilRenewMs,
  type LeaseSummary,
} from "./gpu-lease.js";

const EXPIRES = 1_000_000 + 15 * 60_000;

const body = (overrides: Record<string, unknown> = {}) => ({
  capability: "gpu-lease",
  lease: {
    id: "lease-abc",
    expiresAt: EXPIRES,
    renewBy: EXPIRES - 90_000,
    blocks: 1,
    credentialSha256: `0x${"cc".repeat(32)}`,
    credential: "lease-abc.a-secret-nobody-reading-this-needs",
    ...overrides,
  },
});

describe("leaseSummaryOf", () => {
  it("reads the fields a renewal loop needs", () => {
    expect(leaseSummaryOf(body())).toEqual({
      id: "lease-abc",
      expiresAt: EXPIRES,
      renewBy: EXPIRES - 90_000,
      blocks: 1,
      credentialSha256: `0x${"cc".repeat(32)}`,
    });
  });

  /*
   * The runner names a lease by id and reaches nothing. Leaving the secret out
   * of the type is what keeps it out of log lines, SSE frames and React state
   * that ends up in a devtools snapshot.
   */
  it("leaves the credential behind", () => {
    const summary = leaseSummaryOf(body());
    expect(JSON.stringify(summary)).not.toContain("a-secret-nobody-reading-this-needs");
    expect(summary).not.toHaveProperty("credential");
  });

  /*
   * A lease with an id and no expiry is a lease nothing can renew on time.
   * Treating a missing `renewBy` as "renew now" or "never" would both be
   * inventions, so the three numbers are required together.
   */
  it("refuses a lease it cannot describe", () => {
    expect(leaseSummaryOf(body({ expiresAt: undefined }))).toBeUndefined();
    expect(leaseSummaryOf(body({ renewBy: undefined }))).toBeUndefined();
    expect(leaseSummaryOf(body({ id: 42 }))).toBeUndefined();
    expect(leaseSummaryOf(body({ expiresAt: "soon" }))).toBeUndefined();
  });

  it("returns nothing for a body that is not a rental", () => {
    expect(leaseSummaryOf({ capability: "gpu-job", job: { id: "sim-1" } })).toBeUndefined();
    expect(leaseSummaryOf(null)).toBeUndefined();
    expect(leaseSummaryOf("lease")).toBeUndefined();
  });

  it("carries the rotation flag when the vendor set one", () => {
    expect(leaseSummaryOf(body({ rotated: true }))?.rotated).toBe(true);
    expect(leaseSummaryOf(body())?.rotated).toBeUndefined();
  });
});

describe("the two clocks", () => {
  const lease: LeaseSummary = {
    id: "lease-abc",
    expiresAt: EXPIRES,
    renewBy: EXPIRES - 90_000,
    blocks: 1,
  };

  it("counts down to the block boundary and to the renewal", () => {
    expect(remainingMs(lease, EXPIRES - 60_000)).toBe(60_000);
    expect(untilRenewMs(lease, EXPIRES - 150_000)).toBe(60_000);
  });

  /*
   * Floored rather than signed. A runner recovering from a pause lands past
   * `renewBy`, and a negative number there would read as though there were
   * still time while a `setTimeout` fired immediately anyway.
   */
  it("floors both at zero rather than going negative", () => {
    expect(remainingMs(lease, EXPIRES + 10_000)).toBe(0);
    expect(untilRenewMs(lease, EXPIRES)).toBe(0);
  });

  it("formats a countdown as mm:ss", () => {
    expect(formatBlockClock(0)).toBe("0:00");
    expect(formatBlockClock(9_000)).toBe("0:09");
    expect(formatBlockClock(90_000)).toBe("1:30");
    expect(formatBlockClock(15 * 60_000)).toBe("15:00");
    // A lease that has already ended must not read as one that is running.
    expect(formatBlockClock(-4_000)).toBe("0:00");
  });

  /*
   * Two minutes, because the renewal lead is ninety seconds: below that, the
   * decision that would save the lease is already in flight or already lost.
   */
  it("flags a block that is running out", () => {
    expect(blockRunningOut(150_000)).toBe(false);
    expect(blockRunningOut(90_000)).toBe(true);
    expect(blockRunningOut(0)).toBe(true);
  });
});

describe("describeLeaseEnding", () => {
  /*
   * Plan §5.5 asks for two losses to read differently, and this is the
   * assertion that they do. A panel that quietly called both of them "refused"
   * would be a defect in the argument rather than in the CSS.
   */
  it("tells a policy refusal apart from a lost renewal", () => {
    const refused = describeLeaseEnding({ kind: "refused", blocks: 2 });
    const abandoned = describeLeaseEnding({
      kind: "abandoned",
      blocks: 2,
      detail: "the goal still had a spend pending when the block ran out",
    });

    expect(refused.tone).toBe("no");
    expect(refused.head).toContain("confidential policy");
    expect(abandoned.tone).toBe("wait");
    expect(abandoned.head).not.toContain("refused by");
    expect(abandoned.body).toContain("the budget never got to decide");
  });

  it("quotes the orchestrator's own reason for a lost renewal", () => {
    const view = describeLeaseEnding({
      kind: "abandoned",
      blocks: 1,
      detail: "the decision never resolved after 40 attempts",
    });
    expect(view.body).toContain("40 attempts");
  });

  it("names the run's own limit rather than implying the budget refused", () => {
    const view = describeLeaseEnding({ kind: "block-limit", blocks: 4 });
    expect(view.head).toBe("Stopped after 4 blocks");
    expect(view.body).toContain("rather than the budget's");
    expect(view.tone).toBe("ok");
  });

  it("pluralises a single block", () => {
    expect(describeLeaseEnding({ kind: "block-limit", blocks: 1 }).head).toBe(
      "Stopped after 1 block",
    );
  });

  it("covers every ending a run can produce", () => {
    for (const kind of ["refused", "abandoned", "block-limit", "not-a-lease", "failed"] as const) {
      const view = describeLeaseEnding({ kind, blocks: 1 });
      expect(view.head, kind).not.toBe("");
      expect(view.body, kind).not.toBe("");
    }
  });

  it("falls back to a sentence when no detail came with the failure", () => {
    expect(describeLeaseEnding({ kind: "failed", blocks: 0 }).body).toContain("never completed");
  });
});
