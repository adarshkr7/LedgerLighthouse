import { describe, expect, it } from "vitest";
import type { Address, Hex, PublicClient, WalletClient } from "viem";

import { TraceAnchorClient } from "./anchor.js";

const ANCHOR = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa" as Address;
const VAULT = "0x0C759D06a1c14F43852D7b078Db2f8C342F15921" as Address;
const RELAY_KEY = `0x${"11".repeat(32)}` as Hex;
const ROOT = `0x${"ab".repeat(32)}` as Hex;
const ZERO = `0x${"00".repeat(32)}` as Hex;

interface Stub {
  chainId?: number;
  existingRoot?: Hex;
  txStatus?: "success" | "reverted";
  throwOn?: "read" | "write";
}

/** Records writes so a test can assert one never happened. */
function build(stub: Stub = {}) {
  const writes: unknown[][] = [];

  const publicClient = {
    getChainId: async () => stub.chainId ?? 84532,
    readContract: async () => {
      if (stub.throwOn === "read") throw new Error("rpc exploded");
      return { root: stub.existingRoot ?? ZERO, anchoredBy: VAULT, anchoredAt: 0n, stepCount: 0 };
    },
    waitForTransactionReceipt: async () => ({ status: stub.txStatus ?? "success" }),
  } as unknown as PublicClient;

  const walletClient = {
    account: { address: VAULT },
    writeContract: async (args: Record<string, unknown>) => {
      if (stub.throwOn === "write") throw new Error("out of gas");
      writes.push([args["functionName"], args["args"]]);
      return `0x${"cd".repeat(32)}` as Hex;
    },
  } as unknown as WalletClient;

  const client = new TraceAnchorClient({
    rpcUrl: "http://unused.test",
    anchorAddress: ANCHOR,
    relayKey: RELAY_KEY,
    chainId: 84532,
    clients: { publicClient, walletClient },
  });

  return { client, writes };
}

describe("TraceAnchorClient", () => {
  it("anchors a completed trace", async () => {
    const { client, writes } = build();
    const outcome = await client.anchor(VAULT, 7n, ROOT, 12);

    expect(outcome.kind).toBe("anchored");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe("anchor");
    expect(writes[0]?.[1]).toEqual([VAULT, 7n, ROOT, 12]);
  });

  /*
   * The ordinary second run against one goal. `TraceAnchor` is first-write-wins,
   * so this would revert on chain — reading first turns a wasted transaction
   * into a free `eth_call`, and turns a red line in the log into a fact.
   */
  it("reports an existing anchor as `already`, without writing", async () => {
    const existing = `0x${"ee".repeat(32)}` as Hex;
    const { client, writes } = build({ existingRoot: existing });

    const outcome = await client.anchor(VAULT, 7n, ROOT, 12);
    expect(outcome.kind).toBe("already");
    expect(outcome.kind === "already" && outcome.root).toBe(existing);
    expect(writes).toHaveLength(0);
  });

  it("skips an empty trace rather than reverting on EmptyTrace", async () => {
    const { client, writes } = build();
    const outcome = await client.anchor(VAULT, 7n, ROOT, 0);
    expect(outcome.kind).toBe("skipped");
    expect(writes).toHaveLength(0);
  });

  it("refuses to anchor against the wrong chain", async () => {
    // An anchor on the wrong chain is one the verifier will never find, and it
    // fails silently at read time rather than loudly here.
    const { client, writes } = build({ chainId: 1 });
    const outcome = await client.anchor(VAULT, 7n, ROOT, 12);

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.reason).toContain("wrong chain");
    expect(writes).toHaveLength(0);
  });

  it("reports a reverted anchor as failed", async () => {
    const { client } = build({ txStatus: "reverted" });
    const outcome = await client.anchor(VAULT, 7n, ROOT, 12);
    expect(outcome.kind).toBe("failed");
  });

  /*
   * Anchoring runs after the money has moved and the trace is on disk. A thrown
   * RPC error here must come back as a value, because the caller's contract is
   * that a failed anchor costs the commitment and never the run.
   */
  it("returns a value rather than throwing when the RPC fails", async () => {
    for (const throwOn of ["read", "write"] as const) {
      const { client } = build({ throwOn });
      const outcome = await client.anchor(VAULT, 7n, ROOT, 12);
      expect(outcome.kind, throwOn).toBe("failed");
    }
  });
});
