import { describe, expect, it } from "vitest";
import type { Hex } from "viem";

import { IncoHealthProbe, INCO_PROBE_HANDLE } from "./health.js";
import type { AttestedDecision, DecisionReader } from "./reveal.js";

const SIGNED: AttestedDecision = { approved: true, signatures: ["0xaa", "0xbb"] };

/** A reader that records what it was asked and answers with `answer`. */
function reader(answer: () => Promise<AttestedDecision | undefined>): DecisionReader & {
  asked: Hex[];
} {
  const asked: Hex[] = [];
  return {
    asked,
    read: (handle) => {
      asked.push(handle);
      return answer();
    },
  };
}

describe("IncoHealthProbe", () => {
  it("reports ready when Inco reveals the known decision", async () => {
    const r = reader(async () => SIGNED);
    const health = await new IncoHealthProbe(r).check();

    expect(health.status).toBe("ready");
    // It asks about the recorded, already-public decision and nothing else.
    expect(r.asked).toEqual([INCO_PROBE_HANDLE]);
  });

  /*
   * What a covalidator returning 503 looks like from here: the SDK gives up and
   * throws. The message is the useful part, so it is kept.
   */
  it("reports unavailable with Inco's own error when the reveal throws", async () => {
    const r = reader(async () => {
      throw new Error("Failed to reveal handles");
    });
    const health = await new IncoHealthProbe(r).check();

    expect(health).toMatchObject({ status: "unavailable", detail: "Failed to reveal handles" });
  });

  it("reports unavailable when Inco answers without signatures", async () => {
    const r = reader(async () => ({ approved: true, signatures: [] }));
    expect((await new IncoHealthProbe(r).check()).status).toBe("unavailable");
  });

  /*
   * The SDK retries a 503 internally before giving up, so a dead covalidator
   * usually shows up as a call that never returns. That has to become an
   * answer, or the check itself hangs the way the run did.
   */
  it("reports unavailable when Inco does not answer in time", async () => {
    const r = reader(() => new Promise(() => {}));
    const health = await new IncoHealthProbe(r, { timeoutMs: 20 }).check();

    expect(health.status).toBe("unavailable");
    expect(health.status === "unavailable" && health.detail).toMatch(/no answer/);
  });

  it("reuses a fresh answer instead of asking again", async () => {
    let clock = 1_000;
    const r = reader(async () => SIGNED);
    const probe = new IncoHealthProbe(r, { ttlMs: 30_000, now: () => clock });

    await probe.check();
    clock += 10_000;
    await probe.check();
    expect(r.asked).toHaveLength(1);

    clock += 30_000;
    await probe.check();
    expect(r.asked).toHaveLength(2);
  });

  it("shares one probe between callers that arrive together", async () => {
    let release: (d: AttestedDecision) => void = () => {};
    const r = reader(() => new Promise((resolve) => (release = resolve)));
    const probe = new IncoHealthProbe(r);

    const both = Promise.all([probe.check(), probe.check()]);
    release(SIGNED);
    const [a, b] = await both;

    expect(r.asked).toHaveLength(1);
    expect(a).toBe(b);
  });

  /* A recovery has to be noticed, or one bad minute would stop runs for good. */
  it("notices when Inco comes back", async () => {
    let clock = 0;
    let up = false;
    const r = reader(async () => {
      if (!up) throw new Error("HTTP 503");
      return SIGNED;
    });
    const probe = new IncoHealthProbe(r, { ttlMs: 1_000, now: () => clock });

    expect((await probe.check()).status).toBe("unavailable");
    up = true;
    clock += 1_000;
    expect((await probe.check()).status).toBe("ready");
  });
});
