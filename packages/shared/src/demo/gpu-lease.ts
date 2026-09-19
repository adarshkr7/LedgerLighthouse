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
