/**
 * The Bearer header, and the two ways it can be wrong.
 *
 * Once the signer leaves loopback — a ROFL machine, README.md —
 * `SERVICE_TOKEN` is the only thing between the payer key and the internet, and
 * the guard enforces it only when it has one. That makes the token a matched
 * pair across two processes: set on both sides, or on neither. A client that
 * quietly stopped sending it would not fail loudly here, it would fail as a run
 * that reaches Authorize and dies with a 401, several stages downstream of the
 * mistake.
 */

import { describe, expect, it } from "vitest";

import { SignerClient } from "./signer-client.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";

/** Records the headers of every request, and answers enough to get past parsing. */
function recorder(): { calls: Array<{ url: string; headers: Headers }>; fetch: typeof fetch } {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ address: ADDRESS }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

describe("SignerClient — service token", () => {
  it("sends no authorization header when no token is configured", async () => {
    const { calls, fetch } = recorder();

    await new SignerClient("http://signer.local", fetch).mintPayer();

    // An open signer must see exactly the request it saw before this existed.
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("sends the bearer token on mintPayer", async () => {
    const { calls, fetch } = recorder();

    await new SignerClient("http://signer.local", fetch, "s3cret").mintPayer();

    expect(calls[0]?.headers.get("authorization")).toBe("Bearer s3cret");
  });

  it("sends the bearer token on authorize, keeping content-type", async () => {
    const { calls, fetch } = recorder();

    await new SignerClient("http://signer.local", fetch, "s3cret").authorize(1n, 2n);

    expect(calls[0]?.headers.get("authorization")).toBe("Bearer s3cret");
    // The extra headers must survive being merged with the auth header.
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
  });

  /*
   * The regression this file was written to catch, arriving through the one
   * route that did not go through this client.
   *
   * `sweepGoal` called the signer with its own `fetch` and a bare URL, so it
   * sent no bearer and every sweep against the ROFL signer was a 401 — reported
   * to the console *after* it had closed the goal on chain. Asserted here
   * rather than only in `sweep.test.ts` because the property belongs to the
   * client: every signer route carries the token, no exceptions.
   */
  it("sends the bearer token on sweep, keeping content-type", async () => {
    const { calls, fetch } = recorder();

    await new SignerClient("http://signer.local", fetch, "s3cret").sweep("42");

    expect(calls[0]?.url).toBe("http://signer.local/sweeps");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer s3cret");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
  });

  it("sends only goalId in the sweep body", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await new SignerClient("http://signer.local", fetchImpl, "s3cret").sweep("42");

    // The signer reads the amount, the payee and the token off the chain. A
    // field here would be a field a caller could aim.
    expect(Object.keys(JSON.parse(bodies[0]!) as object)).toEqual(["goalId"]);
  });

  it("treats an empty token as no token", async () => {
    const { calls, fetch } = recorder();

    // `optional()` yields "" for a variable that is present but blank, and an
    // `Authorization: Bearer ` header is worse than none: it is a 401 that
    // looks like a wrong secret rather than an unset one.
    await new SignerClient("http://signer.local", fetch, "").mintPayer();

    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("still sends only goalId and seq in the body", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ address: ADDRESS }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await new SignerClient("http://signer.local", fetchImpl, "s3cret").authorize(7n, 3n);

    // Adding a header must not have become a licence to add fields.
    expect(Object.keys(JSON.parse(bodies[0]!) as object).sort()).toEqual(["goalId", "seq"]);
  });
});

/**
 * The signer limits both its HTTP edge (per-IP) and its enclave key operations
 * (global). Either can answer 429 to a request whose `(goalId, seq)` is
 * perfectly valid and whose budget the vault has **already debited**.
 *
 * So the distinction these tests defend is the same one 425 gets: a 429 must
 * not arrive as `refused`, because `refused` is terminal and the payment loop
 * would abandon a spend that has been paid for.
 */
describe("SignerClient — rate limiting", () => {
  /** Answers one status, with optional headers. */
  function answering(status: number, headers: Record<string, string> = {}): typeof fetch {
    return (async () =>
      new Response(JSON.stringify({ error: "rate limit exceeded" }), {
        status,
        headers: { "content-type": "application/json", ...headers },
      })) as unknown as typeof fetch;
  }

  it("reports 429 as rate-limited rather than refused", async () => {
    const client = new SignerClient("http://signer.local", answering(429, { "retry-after": "17" }));

    const outcome = await client.authorize(1n, 2n);

    expect(outcome).toEqual({
      kind: "rate-limited",
      reason: "rate limit exceeded",
      retryAfterSeconds: 17,
    });
  });

  it("reports 0 when the signer sends no retry-after", async () => {
    const outcome = await new SignerClient("http://signer.local", answering(429)).authorize(1n, 2n);

    expect(outcome).toMatchObject({ kind: "rate-limited", retryAfterSeconds: 0 });
  });

  // The header arrives over the network. Left untrusted, `retry-after: 86400`
  // would park the payment loop for a day on a limit that clears in a minute.
  it.each([
    ["86400", 60],
    ["0", 0],
    ["-5", 0],
    ["soon", 0],
    ["Wed, 21 Oct 2026 07:28:00 GMT", 0],
    ["2.4", 3],
  ])("clamps a retry-after of %s to %i", async (header, expected) => {
    const client = new SignerClient("http://signer.local", answering(429, { "retry-after": header }));

    const outcome = await client.authorize(1n, 2n);

    expect(outcome).toMatchObject({ kind: "rate-limited", retryAfterSeconds: expected });
  });

  it("still treats other 4xx as terminal refusals", async () => {
    // 403 is the policy saying no. Retrying that is the anti-pattern the
    // architecture explicitly forbids, so the two must not blur together.
    const outcome = await new SignerClient("http://signer.local", answering(403)).authorize(1n, 2n);

    expect(outcome).toMatchObject({ kind: "refused", status: 403 });
  });

  it("passes a 429 on a sweep through as a refusal, with the signer's own words", async () => {
    // A sweep strands nothing — the goal stays closed and the balance stays
    // put — so it needs no retry channel, only a message the operator can act
    // on.
    const outcome = await new SignerClient("http://signer.local", answering(429)).sweep("42");

    expect(outcome).toMatchObject({ kind: "refused", status: 429, reason: "rate limit exceeded" });
  });
});
