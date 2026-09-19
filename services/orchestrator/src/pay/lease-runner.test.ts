import { describe, expect, it } from "vitest";

import { LeaseRunner, type LeaseEvent, type PendingReader } from "./lease-runner.js";
import type { PaymentLoop, PaymentResult } from "./payment-loop.js";

const GOAL = 7n;
const HANDLE = `0x${"aa".repeat(32)}` as `0x${string}`;
const TX = `0x${"bb".repeat(32)}` as `0x${string}`;

/** A clock and a sleep that move together, so nothing waits and time passes. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get value() {
      return now;
    },
  };
}

/** A lease body as the vendor sends it, minus what the runner does not read. */
function leaseBody(
  clock: { value: number },
  overrides: { id?: string; blocks?: number; minutes?: number } = {},
) {
  const minutes = overrides.minutes ?? 15;
  const expiresAt = clock.value + minutes * 60_000;
  return {
    capability: "gpu-lease",
    lease: {
      id: overrides.id ?? "lease-abc",
      expiresAt,
      renewBy: expiresAt - 90_000,
      blocks: overrides.blocks ?? 1,
      credentialSha256: `0x${"cc".repeat(32)}`,
      // Present in the real body and deliberately unread by the runner.
      credential: "lease-abc.secret-value-nobody-here-needs",
    },
  };
}

/** Answers each call from a queue, so a test scripts a whole run. */
class ScriptedLoop {
  calls: string[] = [];
  constructor(private readonly results: PaymentResult[]) {}
  async fetchPaid(url: string): Promise<PaymentResult> {
    this.calls.push(url);
    const next = this.results.shift();
    if (next === undefined) throw new Error(`unscripted fetchPaid: ${url}`);
    return next;
  }
}

class ScriptedPending implements PendingReader {
  reads = 0;
  constructor(private readonly values: bigint[] = []) {}
  async pendingSeq(): Promise<bigint> {
    this.reads += 1;
    return this.values.shift() ?? 0n;
  }
}

const paid = (data: unknown): PaymentResult =>
  ({ kind: "paid", data, goalId: GOAL, seq: 1n, terms: {} as never, settlement: undefined });

const refused = (): PaymentResult => ({
  kind: "policy-rejected",
  goalId: GOAL,
  seq: 2n,
  terms: {} as never,
  decisionHandle: HANDLE,
  commitTx: TX,
});

function runnerFor(
  loop: ScriptedLoop,
  pending: ScriptedPending,
  clock: ReturnType<typeof fakeClock>,
  extra: { maxBlocks?: number } = {},
) {
  const events: LeaseEvent[] = [];
  const runner = new LeaseRunner({
    loop: loop as unknown as PaymentLoop,
    pending,
    urlFor: (renewOf) =>
      renewOf === undefined
        ? "http://gpu.test/resource/gpu/lease?sku=rtx4090&minutes=15&workload=gpu-burn"
        : `http://gpu.test/resource/gpu/lease?sku=rtx4090&minutes=15&workload=gpu-burn&renew=${renewOf}`,
    now: clock.now,
    sleep: clock.sleep,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { runner, events };
}

const typesOf = (events: LeaseEvent[]) => events.map((e) => e.type);

describe("opening a lease", () => {
  it("reports the lease and its renewal deadline", async () => {
    const clock = fakeClock();
    const loop = new ScriptedLoop([paid(leaseBody(clock))]);
    const { runner, events } = runnerFor(loop, new ScriptedPending(), clock, { maxBlocks: 1 });

    const outcome = await runner.run(GOAL);

    expect(outcome.blocks).toBe(1);
    expect(outcome.ended).toBe("block-limit");
    expect(typesOf(events)).toEqual(["lease-opened", "lease-ended"]);
  });

  /*
   * The runner names a lease by id and reaches nothing. Keeping the credential
   * out of the summary is what keeps it out of log lines, SSE frames and React
   * state that ends up in a devtools snapshot.
   */
  it("never carries the credential into an event", async () => {
    const clock = fakeClock();
    const loop = new ScriptedLoop([paid(leaseBody(clock))]);
    const { runner, events } = runnerFor(loop, new ScriptedPending(), clock, { maxBlocks: 1 });

    await runner.run(GOAL);
    expect(JSON.stringify(events)).not.toContain("secret-value-nobody-here-needs");
  });

  it("says so when what came back is not a lease", async () => {
    const clock = fakeClock();
    // The one-shot job route's body. Bought as asked, and nothing to renew.
    const loop = new ScriptedLoop([paid({ capability: "gpu-job", job: { id: "sim-1" } })]);
    const { runner, events } = runnerFor(loop, new ScriptedPending(), clock);

    const outcome = await runner.run(GOAL);
    expect(outcome).toMatchObject({ blocks: 1, ended: "not-a-lease" });
    expect(events).toEqual([]);
  });

  it("reports a first purchase that never paid", async () => {
    const clock = fakeClock();
    const loop = new ScriptedLoop([{ kind: "failed", reason: "vendor 502" }]);
    const { runner } = runnerFor(loop, new ScriptedPending(), clock);

    expect(await runner.run(GOAL)).toMatchObject({
      blocks: 0,
      ended: "failed",
      detail: "vendor 502",
    });
  });
});

describe("renewing", () => {
  it("renews at the vendor's deadline and extends the block", async () => {
    const clock = fakeClock();
    const first = leaseBody(clock);
    const loop = new ScriptedLoop([
      paid(first),
      paid({ ...first, lease: { ...first.lease, expiresAt: first.lease.expiresAt + 900_000, blocks: 2 } }),
    ]);
    const { runner, events } = runnerFor(loop, new ScriptedPending(), clock, { maxBlocks: 2 });

    const outcome = await runner.run(GOAL);

    expect(outcome.blocks).toBe(2);
    expect(typesOf(events)).toEqual(["lease-opened", "renewal-due", "renewed", "lease-ended"]);
    // The renewal names the lease it extends; the vendor cannot infer it.
    expect(loop.calls[1]).toContain("renew=lease-abc");
  });

  /*
   * The lead time is the vendor's to state, not the buyer's to recompute. A
   * deadline invented on this side would drift from the one the seller
   * enforces, and the seller holds the machine.
   */
  it("waits until renewBy and not a moment past expiry", async () => {
    const clock = fakeClock();
    const first = leaseBody(clock);
    const loop = new ScriptedLoop([paid(first), refused()]);
    const { runner, events } = runnerFor(loop, new ScriptedPending(), clock, { maxBlocks: 3 });

    await runner.run(GOAL);

    const due = events.find((e) => e.type === "renewal-due");
    expect(due?.type === "renewal-due" && due.remainingMs).toBe(90_000);
  });

  it("stops at the block limit even when renewals keep succeeding", async () => {
    const clock = fakeClock();
    const body = () => leaseBody(clock);
    const loop = new ScriptedLoop([paid(body()), paid(body()), paid(body())]);
    const { runner, events } = runnerFor(loop, new ScriptedPending(), clock, { maxBlocks: 3 });

    const outcome = await runner.run(GOAL);

    expect(outcome).toMatchObject({ blocks: 3, ended: "block-limit" });
    expect(events.at(-1)).toMatchObject({ type: "lease-ended", reason: "block-limit" });
  });
});

describe("the two ways to lose a lease", () => {
  /*
   * §5.5's first failure mode, and the system working. The budget ran out, the
   * encrypted balance said no, and the news arrives while there is still block
   * left — which is the whole reason the lead time exists.
   */
  it("reports a policy refusal with time still on the block", async () => {
    const clock = fakeClock();
    const loop = new ScriptedLoop([paid(leaseBody(clock)), refused()]);
    const { runner, events } = runnerFor(loop, new ScriptedPending(), clock, { maxBlocks: 3 });

    const outcome = await runner.run(GOAL);

    expect(outcome).toMatchObject({ blocks: 1, ended: "refused" });
    const refusal = events.find((e) => e.type === "renewal-refused");
    expect(refusal?.type === "renewal-refused" && refusal.remainingMs).toBe(90_000);
    // The chain evidence rides along, so a viewer can check the bounce.
    expect(refusal).toMatchObject({ decisionHandle: HANDLE, commitTx: TX });
    expect(events.at(-1)).toMatchObject({ type: "lease-ended", reason: "refused" });
  });

  /*
   * §5.5's second failure mode: the same loss for a worse reason. An operator
   * reading a trace has to be able to tell a policy refusal from a slow chain
   * without guessing, which is why this is not the same event.
   */
  it("distinguishes a slow chain from a refusal", async () => {
    const clock = fakeClock();
    // Busy for longer than the lead time, so the boundary arrives first.
    const pending = new ScriptedPending(Array.from({ length: 200 }, () => 3n));
    const loop = new ScriptedLoop([paid(leaseBody(clock))]);
    const { runner, events } = runnerFor(loop, pending, clock, { maxBlocks: 3 });

    const outcome = await runner.run(GOAL);

    expect(outcome.ended).toBe("abandoned");
    const abandoned = events.find((e) => e.type === "renewal-abandoned");
    expect(abandoned?.type === "renewal-abandoned" && abandoned.reason).toBe("chain-busy");
    expect(events.find((e) => e.type === "renewal-refused")).toBeUndefined();
    // Never issued: the goal was never clear, so nothing was even attempted.
    expect(loop.calls).toHaveLength(1);
  });

  it("says it is waiting once, not once per poll", async () => {
    const clock = fakeClock();
    const pending = new ScriptedPending(Array.from({ length: 200 }, () => 3n));
    const loop = new ScriptedLoop([paid(leaseBody(clock))]);
    const { runner, events } = runnerFor(loop, pending, clock, { maxBlocks: 3 });

    await runner.run(GOAL);

    expect(events.filter((e) => e.type === "renewal-waiting")).toHaveLength(1);
    // It really did poll more than once before giving up.
    expect(pending.reads).toBeGreaterThan(2);
  });

  /*
   * Busy, then clear, with time to spare. The point of waiting at all: a goal
   * that frees up inside the lead window still gets its renewal.
   */
  it("renews once the goal frees up", async () => {
    const clock = fakeClock();
    const first = leaseBody(clock);
    const pending = new ScriptedPending([5n, 5n, 0n]);
    const loop = new ScriptedLoop([paid(first), paid(first)]);
    const { runner, events } = runnerFor(loop, pending, clock, { maxBlocks: 2 });

    const outcome = await runner.run(GOAL);

    expect(outcome.blocks).toBe(2);
    expect(typesOf(events)).toContain("renewal-waiting");
    expect(typesOf(events)).toContain("renewed");
  });

  it("reports a decision that never resolved as its own reason", async () => {
    const clock = fakeClock();
    const loop = new ScriptedLoop([
      paid(leaseBody(clock)),
      { kind: "decision-unavailable", goalId: GOAL, seq: 2n, attempts: 40, elapsedMs: 120_000 },
    ]);
    const { runner, events } = runnerFor(loop, new ScriptedPending(), clock, { maxBlocks: 3 });

    const outcome = await runner.run(GOAL);

    expect(outcome.ended).toBe("abandoned");
    const abandoned = events.find((e) => e.type === "renewal-abandoned");
    expect(abandoned?.type === "renewal-abandoned" && abandoned.reason).toBe(
      "decision-unavailable",
    );
    expect(outcome.detail).toContain("40 attempts");
  });

  it("reports a vendor failure separately again", async () => {
    const clock = fakeClock();
    const loop = new ScriptedLoop([
      paid(leaseBody(clock)),
      { kind: "failed", reason: "lease has already ended; buy a new one" },
    ]);
    const { runner, events } = runnerFor(loop, new ScriptedPending(), clock, { maxBlocks: 3 });

    const outcome = await runner.run(GOAL);

    expect(outcome.ended).toBe("abandoned");
    const abandoned = events.find((e) => e.type === "renewal-abandoned");
    expect(abandoned?.type === "renewal-abandoned" && abandoned.reason).toBe("vendor-failed");
    expect(outcome.detail).toContain("already ended");
  });

  it("treats a renewal 200 with no lease in it as a vendor failure", async () => {
    const clock = fakeClock();
    const loop = new ScriptedLoop([paid(leaseBody(clock)), paid({ capability: "gpu-lease" })]);
    const { runner, events } = runnerFor(loop, new ScriptedPending(), clock, { maxBlocks: 3 });

    const outcome = await runner.run(GOAL);
    expect(outcome.ended).toBe("abandoned");
    expect(events.find((e) => e.type === "renewal-abandoned")).toMatchObject({
      reason: "vendor-failed",
    });
  });
});
