/**
 * The buyer's read-only view of a lease it just paid for.
 *
 * `services/vendor-gpu` owns the lease and its `LeaseResponse` type. This is
 * the same object seen from the other side of the wire, declared here because
 * the orchestrator and the console both need it and neither may import the
 * vendor — `scripts/check-boundary.mjs` enforces that for the orchestrator, and
 * the console is a browser bundle that cannot reach a service at all.
 *
 * ## What it deliberately leaves out
 *
 * The credential. The renewal loop never needs it: renewing names the lease by
 * id, and the machine is reached by whoever holds the secret, which is not this
 * process's business. Leaving it out of the type is what keeps it out of the
 * places a lease summary travels — a log line, an SSE frame, a React state
 * object that ends up in a devtools snapshot.
 *
 * `credentialSha256` stays, because it is the thing the trace records and the
 * console can show a viewer without handing them anything.
 */

export interface LeaseSummary {
  readonly id: string;
  readonly expiresAt: number;
  /** When to start renewing. Expiry minus the vendor's stated lead time. */
  readonly renewBy: number;
  readonly blocks: number;
  readonly credentialSha256?: string;
  /** True when the vendor issued a fresh credential because it lost the old one. */
  readonly rotated?: boolean;
}

/**
 * Pulls the lease out of a paid rental body, or nothing.
 *
 * Structural and defensive, like `vendorUpstreamOf`: this is a third party's
 * JSON, and a body that is missing a field or carries the wrong type for one is
 * a body this cannot describe rather than a reason to throw. A caller that gets
 * `undefined` has bought something that is not a lease, which is the honest
 * answer for a one-shot job.
 *
 * The three numbers are required together. A lease with an id and no expiry is
 * a lease nothing can renew on time, and treating a missing `renewBy` as "renew
 * immediately" or "never" would both be inventions.
 */
export function leaseSummaryOf(data: unknown): LeaseSummary | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const lease = (data as { lease?: unknown }).lease;
  if (typeof lease !== "object" || lease === null) return undefined;

  const raw = lease as Record<string, unknown>;
  const num = (key: string) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : undefined;

  const id = typeof raw["id"] === "string" ? raw["id"] : undefined;
  const expiresAt = num("expiresAt");
  const renewBy = num("renewBy");
  if (id === undefined || expiresAt === undefined || renewBy === undefined) return undefined;

  return {
    id,
    expiresAt,
    renewBy,
    blocks: num("blocks") ?? 1,
    ...(typeof raw["credentialSha256"] === "string"
      ? { credentialSha256: raw["credentialSha256"] }
      : {}),
    ...(typeof raw["rotated"] === "boolean" ? { rotated: raw["rotated"] } : {}),
  };
}

/** Milliseconds of block left, floored at zero. */
export function remainingMs(lease: LeaseSummary, now: number): number {
  return Math.max(0, lease.expiresAt - now);
}

/**
 * Milliseconds until a renewal should start, floored at zero.
 *
 * Zero means start now. It is already zero for a lease whose `renewBy` has
 * passed, which is the case a runner recovering from a pause lands in, and
 * answering a negative number there would have a `setTimeout` fire immediately
 * anyway while reading as though there were time left.
 */
export function untilRenewMs(lease: LeaseSummary, now: number): number {
  return Math.max(0, lease.renewBy - now);
}

/** How a rental run ended. Mirrors `LeaseRunOutcome.ended`. */
export type LeaseEnding =
  | "refused"
  | "abandoned"
  | "block-limit"
  | "not-a-lease"
  | "failed";

export interface LeaseEndingView {
  readonly tone: "ok" | "no" | "wait";
  readonly head: string;
  readonly body: string;
}

/**
 * What to tell a viewer about how a rental ended.
 *
 * Here rather than in the component for the reason `search-result.ts` gives
 * about the `javascript:` filter: `apps/web` has no test runner, and this is
 * the part of the panel that can be wrong in a way nobody notices. Plan §5.5
 * asks for two losses to read differently, and a component that quietly called
 * both of them "refused" would hand a viewer the wrong conclusion about what
 * they had just watched — which is a defect in the argument, not in the CSS.
 *
 * `blocks` and `detail` come from the run. `detail` is the orchestrator's own
 * sentence about why a renewal was lost; it is never the vendor's prose and
 * never a model's, so it is rendered as the console's own voice.
 */
export function describeLeaseEnding(done: {
  kind: LeaseEnding;
  blocks: number;
  detail?: string | undefined;
}): LeaseEndingView {
  switch (done.kind) {
    case "refused":
      return {
        tone: "no",
        head: "Renewal refused by the confidential policy",
        body:
          "The budget would not cover another block, so the lease ends when its current block " +
          "does. Nothing public refused this: the price was the same as the block before it and " +
          "well under the per-call cap. The encrypted balance is the only thing that said no, " +
          "and the agent was told while the machine was still up.",
      };
    case "abandoned":
      return {
        tone: "wait",
        head: "Renewal lost, not refused",
        body:
          `${done.detail ?? "The renewal did not complete."} This is a different outcome from a ` +
          "policy refusal and is reported as one: the budget never got to decide.",
      };
    case "block-limit":
      return {
        tone: "ok",
        head: `Stopped after ${done.blocks} ${done.blocks === 1 ? "block" : "blocks"}`,
        body:
          "The run hit its own block limit rather than the budget's. Raise MAX_LEASE_BLOCKS to " +
          "let a rental run until the encrypted balance refuses it.",
      };
    case "not-a-lease":
      return {
        tone: "ok",
        head: "Bought a bounded job",
        body:
          "This resource sells one job rather than a renewable block, so there was nothing to " +
          "renew.",
      };
    case "failed":
      return {
        tone: "no",
        head: "Rental failed",
        body: done.detail ?? "The first purchase never completed.",
      };
  }
}

/**
 * A block countdown as mm:ss, floored at zero.
 *
 * Floored rather than signed, because a negative countdown is a lease that has
 * already ended and "-0:04" reads as though something is still running.
 */
export function formatBlockClock(ms: number): string {
  const whole = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * True when a block is close enough to its end that the panel should say so.
 *
 * Two minutes, because the renewal lead is ninety seconds: below that, the
 * decision that would save this lease is either already in flight or already
 * lost, and the number on screen has stopped being something a viewer can act
 * on. Tied to `RENEW_LEAD_SECONDS`' own reasoning rather than picked for looks.
 */
export function blockRunningOut(remainingMs: number): boolean {
  return remainingMs < 120_000;
}

