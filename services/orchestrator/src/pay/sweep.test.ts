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

import { SignerClient } from "./signer-client.js";
import { askSignerToSweep, sweepGoal } from "./sweep.js";

const USDC = `0x${"33".repeat(20)}` as const;
const OWNER = `0x${"44".repeat(20)}` as const;
const PAYER = `0x${"55".repeat(20)}` as const;

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
  it("refuses without a facilitator rather than signing something nobody submits", async () => {
    const { calls, client } = signerReturning(200, SIGNED);

    const outcome = await sweepGoal("7", {
      signer: client,
      facilitatorUrl: undefined,
      usdcAddress: USDC,
    });

    expect(outcome.kind).toBe("refused");
    // And it did not ask the signer to sign anything on the way to saying so.
    expect(calls).toHaveLength(0);
  });

  it("reaches the signer with the bearer the client carries", async () => {
    const { calls, client } = signerReturning(200, SIGNED);

    await sweepGoal("7", {
      signer: client,
      facilitatorUrl: "http://facilitator.local",
      usdcAddress: USDC,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ success: true, transaction: "0xdead" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    expect(calls[0]?.url).toBe("http://signer.local/sweeps");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer s3cret");
  });

  it("passes the signer's refusal through with its status and message", async () => {
    // The informative ones: "goal is still open", "payer holds no USDC". They
    // are the reason a sweep failed, so flattening them to a generic 502 would
    // leave the console unable to say what to do next.
    const reason = `refused: payer ${PAYER} holds no ${USDC}.`;
    const { client } = signerReturning(409, { error: reason });

    const outcome = await sweepGoal("7", {
      signer: client,
      facilitatorUrl: "http://facilitator.local",
      usdcAddress: USDC,
    });

    expect(outcome).toEqual({ kind: "refused", status: 409, reason });
  });

  it("forwards the signed authorization to the facilitator unchanged", async () => {
    const { client } = signerReturning(200, SIGNED);
    let envelope: unknown;

    const outcome = await sweepGoal("7", {
      signer: client,
      facilitatorUrl: "http://facilitator.local",
      usdcAddress: USDC,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        envelope = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ success: true, transaction: "0xdead" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    // Nothing this process constructs may widen what the signer signed.
    const { paymentPayload } = envelope as { paymentPayload: { payload: unknown } };
    expect(paymentPayload.payload).toEqual({
      signature: SIGNED.signature,
      authorization: SIGNED.authorization,
    });
    expect(outcome).toMatchObject({ kind: "settled", amount: "250000", to: OWNER });
  });

  it("reports a failed settlement rather than claiming the money moved", async () => {
    const { client } = signerReturning(200, SIGNED);

    const outcome = await sweepGoal("7", {
      signer: client,
      facilitatorUrl: "http://facilitator.local",
      usdcAddress: USDC,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ success: false, errorReason: "payer balance 0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    expect(outcome).toEqual({ kind: "failed", reason: "payer balance 0" });
  });

  it("names the network the signer signed for", async () => {
    // A sweep signed on Base must not reach the facilitator labelled base-sepolia.
    const { client } = signerReturning(200, { ...SIGNED, chainId: 8453 });
    let envelope: unknown;

    await sweepGoal("7", {
      signer: client,
      facilitatorUrl: "http://facilitator.local",
      usdcAddress: USDC,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        envelope = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ success: true, transaction: "0xdead" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const sent = envelope as {
      paymentPayload: { network: string };
      paymentRequirements: { network: string };
    };
    expect(sent.paymentPayload.network).toBe("base");
    expect(sent.paymentRequirements.network).toBe("base");
  });

  it("refuses to forward a signature for a chain it does not know", async () => {
    const { client } = signerReturning(200, { ...SIGNED, chainId: 1 });
    let forwarded = false;

    const outcome = await sweepGoal("7", {
      signer: client,
      facilitatorUrl: "http://facilitator.local",
      usdcAddress: USDC,
      fetchImpl: (async () => {
        forwarded = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(outcome.kind).toBe("failed");
    expect(forwarded).toBe(false);
  });
});

describe("sweepGoal on an escrow vault", () => {
  const VAULT = `0x${"66".repeat(20)}` as const;
  const PAYMENT = {
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
  const ESCROW_SIGNED = { ...SIGNED, payment: PAYMENT };
  const TX = `0x${"ef".repeat(32)}` as const;

  it("submits through the relay, with no facilitator, what the signer signed", async () => {
    const { client } = signerReturning(200, ESCROW_SIGNED);
    const sent: unknown[][] = [];

    const outcome = await sweepGoal("7", {
      signer: client,
      facilitatorUrl: undefined,
      relay: {
        sweep: async (...args) => {
          sent.push(args);
          return { txHash: TX };
        },
      },
      usdcAddress: USDC,
      fetchImpl: (async () => {
        throw new Error("the facilitator has no part in this");
      }) as unknown as typeof fetch,
    });

    expect(sent).toEqual([[PAYMENT, SIGNED.signature]]);
    expect(outcome).toMatchObject({
      kind: "settled",
      amount: "250000",
      to: OWNER,
      settlement: { success: true, transaction: TX },
    });
  });

  it("reports the vault's refusal as a failure, not a settlement", async () => {
    const { client } = signerReturning(200, ESCROW_SIGNED);

    const outcome = await sweepGoal("7", {
      signer: client,
      facilitatorUrl: undefined,
      relay: {
        sweep: async () => {
          throw new Error("execution reverted: PaymentMismatch\nmore detail");
        },
      },
      usdcAddress: USDC,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "the vault refused the sweep: execution reverted: PaymentMismatch",
    });
  });

  it("never sends an escrow signature to the facilitator", async () => {
    const { client } = signerReturning(200, ESCROW_SIGNED);
    let forwarded = false;

    const outcome = await sweepGoal("7", {
      signer: client,
      facilitatorUrl: "http://facilitator.local",
      usdcAddress: USDC,
      fetchImpl: (async () => {
        forwarded = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(outcome.kind).toBe("failed");
    expect(forwarded).toBe(false);
  });

  it("still says a direct signature cannot be submitted when no facilitator exists", async () => {
    const { client } = signerReturning(200, SIGNED);

    const outcome = await sweepGoal("7", {
      signer: client,
      facilitatorUrl: undefined,
      relay: { sweep: async () => ({ txHash: TX }) },
      usdcAddress: USDC,
    });

    expect(outcome).toMatchObject({ kind: "refused", status: 409 });
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
