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
import { sweepGoal } from "./sweep.js";

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
    const { client } = signerReturning(409, { error: "refused: goal 7 is still open." });

    const outcome = await sweepGoal("7", {
      signer: client,
      facilitatorUrl: "http://facilitator.local",
      usdcAddress: USDC,
    });

    expect(outcome).toEqual({
      kind: "refused",
      status: 409,
      reason: "refused: goal 7 is still open.",
    });
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
});
