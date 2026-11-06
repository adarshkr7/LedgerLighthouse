/**
 * The sweep's forwarding behaviour.
 *
 * This path had no tests, and the one bug it shipped was invisible without
 * them: it reached the signer by URL rather than through `SignerClient`, so it
 * sent no bearer and returned 401 against the enclave. The type now makes that
 * unexpressible — `SweepConfig.signer` is a `SignerClient` — and these cover
 * the behaviour either side of it.
 */

import { describe, expect, it } from "vitest";

import { SignerClient, type EscrowPaymentTerms } from "./signer-client.js";
import { askSignerToSweep, sweepGoal } from "./sweep.js";

const USDC = `0x${"33".repeat(20)}` as const;
const OWNER = `0x${"44".repeat(20)}` as const;
const PAYER = `0x${"55".repeat(20)}` as const;
const VAULT = `0x${"66".repeat(20)}` as const;
const TX = `0x${"ef".repeat(32)}` as const;

const PAYMENT: EscrowPaymentTerms = {
  operator: VAULT,
  payer: PAYER,
  receiver: OWNER,
  token: USDC,
  maxAmount: "250000",
  preApprovalExpiry: 3700,
  authorizationExpiry: 3700,
  refundExpiry: 3700,
  salt: "129127208515966861312",
};

const SIGNED = {
  goalId: "7",
  seq: "sweep",
  token: USDC,
  chainId: 84532,
  authorization: {
    from: PAYER,
    to: OWNER,
    value: "250000",
    validAfter: "100",
    validBefore: "3700",
    nonce: `0x${"ab".repeat(32)}`,
  },
  signature: `0x${"cd".repeat(65)}`,
  termsHash: `0x${"00".repeat(32)}`,
  payment: PAYMENT,
};

/** A signer that answers `/sweeps` with `body`, and records what it was sent. */
function signerReturning(status: number, body: unknown) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, client: new SignerClient("http://signer.local", fetchImpl, "s3cret") };
}

describe("sweepGoal", () => {
  const relayed = () => {
    const sent: unknown[][] = [];
    return {
      sent,
      relay: {
        sweep: async (payment: EscrowPaymentTerms, signature: `0x${string}`) => {
          sent.push([payment, signature]);
          return { txHash: TX };
        },
      },
    };
  };

  it("reaches the signer with the bearer the client carries", async () => {
    const { calls, client } = signerReturning(200, SIGNED);

    await sweepGoal("7", { signer: client, relay: relayed().relay });

    expect(calls[0]?.url).toBe("http://signer.local/sweeps");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer s3cret");
  });

  it("passes the signer's refusal through with its status and message", async () => {
    // The informative ones: "goal is still open", "payer holds no USDC". They
    // are the reason a sweep failed, so flattening them to a generic 502 would
    // leave the console unable to say what to do next.
    const reason = `refused: payer ${PAYER} holds no ${USDC}.`;
    const { client } = signerReturning(409, { error: reason });
    const { relay, sent } = relayed();

    const outcome = await sweepGoal("7", { signer: client, relay });

    expect(outcome).toEqual({ kind: "refused", status: 409, reason });
    expect(sent).toHaveLength(0);
  });

  it("submits exactly what the signer signed", async () => {
    // Nothing this process constructs may widen what the signer signed.
    const { client } = signerReturning(200, SIGNED);
    const { relay, sent } = relayed();

    const outcome = await sweepGoal("7", { signer: client, relay });

    expect(sent).toEqual([[PAYMENT, SIGNED.signature]]);
    expect(outcome).toMatchObject({
      kind: "settled",
      amount: "250000",
      to: OWNER,
      settlement: { success: true, transaction: TX, network: "base-sepolia", payer: PAYER },
    });
  });

  it("reports the vault's refusal as a failure, not a settlement", async () => {
    const { client } = signerReturning(200, SIGNED);

    const outcome = await sweepGoal("7", {
      signer: client,
      relay: {
        sweep: async () => {
          throw new Error("execution reverted: PaymentMismatch\nmore detail");
        },
      },
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "the vault refused the sweep: execution reverted: PaymentMismatch",
    });
  });

  it("names the network the signer signed for", async () => {
    const { client } = signerReturning(200, { ...SIGNED, chainId: 8453 });

    const outcome = await sweepGoal("7", { signer: client, relay: relayed().relay });

    expect(outcome).toMatchObject({ settlement: { network: "base" } });
  });

  it("submits nothing for a chain it does not know", async () => {
    const { client } = signerReturning(200, { ...SIGNED, chainId: 1 });
    const { relay, sent } = relayed();

    const outcome = await sweepGoal("7", { signer: client, relay });

    expect(outcome.kind).toBe("failed");
    expect(sent).toHaveLength(0);
  });

  it("submits nothing when the signer gives no escrow payment", async () => {
    const { payment: _none, ...plain } = SIGNED;
    const { client } = signerReturning(200, plain);
    const { relay, sent } = relayed();

    const outcome = await sweepGoal("7", { signer: client, relay });

    expect(outcome.kind).toBe("failed");
    expect(sent).toHaveLength(0);
  });
});

/** A signer that answers each `/sweeps` call with the next response in `script`. */
function signerScripted(script: ReadonlyArray<{ status: number; body: unknown }>) {
  let calls = 0;
  const fetchImpl = (async () => {
    const next = script[Math.min(calls, script.length - 1)]!;
    calls += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls: () => calls, client: new SignerClient("http://signer.local", fetchImpl) };
}

const STILL_OPEN = { status: 409, body: { error: "refused: goal 7 is still open. Close it first." } };

describe("askSignerToSweep", () => {
  /*
   * The case from the first live run: closeGoal confirmed, and the signer's
   * RPC answered from a node that had not seen it yet.
   */
  it("waits out a stale 'still open' after a close", async () => {
    const { calls, client } = signerScripted([STILL_OPEN, STILL_OPEN, { status: 200, body: SIGNED }]);

    const outcome = await askSignerToSweep(client, "7", { intervalMs: 0 });

    expect(outcome.kind).toBe("signed");
    expect(calls()).toBe(3);
  });

  it("gives up on a goal that stays open", async () => {
    const { calls, client } = signerScripted([STILL_OPEN]);

    const outcome = await askSignerToSweep(client, "7", { attempts: 4, intervalMs: 0 });

    expect(outcome).toMatchObject({ kind: "refused", status: 409 });
    expect(calls()).toBe(4);
  });

  it("does not retry any other refusal", async () => {
    const { calls, client } = signerScripted([
      { status: 404, body: { error: `refused: no key held for payer ${PAYER}.` } },
    ]);

    const outcome = await askSignerToSweep(client, "7", { intervalMs: 0 });

    expect(outcome).toMatchObject({ kind: "refused", status: 404 });
    expect(calls()).toBe(1);
  });
});
