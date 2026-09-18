import { describe, expect, it } from "vitest";

import { GPU_SKUS, GPU_WORKLOADS } from "@ntux402/shared";

import { SimulatedGpuProvider } from "./simulated.js";
import type { JobRequest } from "./types.js";

/** A clock and a sleep that move together, so nothing waits and time still passes. */
function fakeClock() {
  let now = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
}

const request = (overrides: Partial<JobRequest> = {}): JobRequest => ({
  sku: GPU_SKUS.rtx4090,
  minutes: 15,
  workload: GPU_WORKLOADS["gpu-burn"],
  idempotencyKey: `0x${"22".repeat(32)}`,
  ...overrides,
});

describe("SimulatedGpuProvider", () => {
  it("models provisioning and compresses the block", async () => {
    const clock = fakeClock();
    const provider = new SimulatedGpuProvider({
      provisionMs: 30_000,
      timeScale: 0,
      sleep: clock.sleep,
      now: clock.now,
    });

    const result = await provider.runJob(request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Provisioning is the window plan §5.4 is about, so it is modelled at size.
    expect(result.provisionMs).toBe(30_000);
    // The block is not. Nothing is learned from waiting fifteen minutes.
    expect(result.runMs).toBe(0);
    expect(clock.slept).toEqual([30_000, 0]);
  });

  it("scales the run when asked to", async () => {
    const clock = fakeClock();
    const provider = new SimulatedGpuProvider({
      provisionMs: 0,
      timeScale: 0.001,
      sleep: clock.sleep,
      now: clock.now,
    });
    const result = await provider.runJob(request({ minutes: 60 }));
    expect(result.ok && result.runMs).toBe(3_600); // 60 min * 60_000 * 0.001
  });

  /*
   * Every result says so, and the handler copies it into the response body and
   * therefore into the trace. A run record that cannot be told apart from a
   * real rental is a run record nobody should trust.
   */
  it("always says it is simulated", async () => {
    const result = await new SimulatedGpuProvider({ provisionMs: 0 }).runJob(request());
    expect(result.ok && result.simulated).toBe(true);
  });

  /*
   * Derived from the idempotency key rather than random, so a duplicate request
   * is visible in a log instead of looking like a second legitimate job. Phase
   * 2's nonce-keyed lease store relies on the same property.
   */
  it("derives a stable job id from the idempotency key", async () => {
    const provider = new SimulatedGpuProvider({ provisionMs: 0 });
    const first = await provider.runJob(request());
    const again = await provider.runJob(request());
    expect(first.ok && again.ok && first.jobId).toBe(again.ok ? again.jobId : "");

    const other = await provider.runJob(request({ idempotencyKey: `0x${"ff".repeat(32)}` }));
    expect(other.ok && other.jobId).not.toBe(first.ok ? first.jobId : "");
  });

  it("reports the same metrics for the same request and different ones otherwise", async () => {
    const provider = new SimulatedGpuProvider({ provisionMs: 0 });
    const a = await provider.runJob(request());
    const b = await provider.runJob(request());
    expect(a.ok && b.ok && a.metrics).toEqual(b.ok ? b.metrics : null);

    const bench = await provider.runJob(request({ workload: GPU_WORKLOADS["matmul-bench"] }));
    expect(bench.ok && bench.metrics).toMatchObject({ workload: "matmul-bench" });
  });

  /*
   * No provider, no reported cost. The ledger then charges the quoted price,
   * which is what it does for a real provider that stays quiet — and treating
   * an unknown as zero would make silence the cheapest way past the ceiling.
   */
  it("reports no cost", async () => {
    const result = await new SimulatedGpuProvider({ provisionMs: 0 }).runJob(request());
    expect(result.ok && result.reportedCostAtomic).toBeUndefined();
  });

  describe("injected failures", () => {
    it("refuses before allocating when the failure is pre-provision", async () => {
      const clock = fakeClock();
      const provider = new SimulatedGpuProvider({
        provisionMs: 30_000,
        sleep: clock.sleep,
        now: clock.now,
        failWith: { status: 503, error: "no capacity in region", provisioned: false },
      });

      const result = await provider.runJob(request());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result).toMatchObject({ status: 503, provisioned: false });
      // The point of the flag: nothing was allocated, so no meter started.
      expect(clock.slept).toEqual([]);
    });

    it("reports a failure that happened after a machine existed", async () => {
      const clock = fakeClock();
      const provider = new SimulatedGpuProvider({
        provisionMs: 30_000,
        sleep: clock.sleep,
        now: clock.now,
        failWith: { status: 500, error: "instance died during setup", provisioned: true },
      });

      const result = await provider.runJob(request());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result).toMatchObject({ status: 500, provisioned: true });
      expect(clock.slept).toEqual([30_000]);
    });
  });
});
