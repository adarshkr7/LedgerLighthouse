/**
 * What a rental is doing, while it is doing it.
 *
 * A one-shot purchase has one outcome and the `Outcome` panel says it. A lease
 * has a shape instead: a block that is running down, a renewal that is due, and
 * an ending that is either the budget's decision or something going wrong. This
 * renders that shape, and nothing else on screen can.
 *
 * ## Where the wording lives
 *
 * `describeLeaseEnding`, `formatBlockClock` and `blockRunningOut` are in
 * `@ntux402/shared`, for the reason the `javascript:` filter is: this app has
 * no test runner, and the wording is the part that can be wrong in a way nobody
 * notices. Plan §5.5 asks for two losses to read differently, and a panel that
 * quietly called both of them "refused" would be a defect in the argument
 * rather than in the CSS. What is left here is layout.
 *
 * ## The countdown
 *
 * Driven by a one-second tick rather than by events, because the interesting
 * thing between events is time passing. It stops the moment the lease ends: a
 * counter still running under a dead lease is a lie that gets more wrong every
 * second.
 */

import { useEffect, useState } from "react";

import {
  blockRunningOut,
  describeLeaseEnding,
  formatBlockClock,
  remainingMs,
} from "@ntux402/shared";

import type { LeaseDone, LeaseEvent, LeaseView } from "../lib/run.js";

/** The newest lease any event mentioned. */
function latestLease(events: readonly LeaseEvent[]): LeaseView | undefined {
  return events.at(-1)?.lease;
}

export function LeasePanel({
  events,
  done,
}: {
  events: readonly LeaseEvent[];
  done: LeaseDone | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());

  const lease = latestLease(events);
  const ended = done !== undefined;

  useEffect(() => {
    if (ended || lease === undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ended, lease]);

  if (lease === undefined && done === undefined) return null;

  const waiting = events.at(-1)?.type === "renewal-waiting";
  const due = events.at(-1)?.type === "renewal-due";
  const remaining = lease ? remainingMs(lease, now) : 0;

  return (
    <section className="d-lease" aria-label="Lease">
      {lease ? (
        <div className="d-lease-head">
          <span className="d-lease-id" title={lease.id}>
            {lease.id}
          </span>
          <span className="d-lease-blocks">
            {lease.blocks} {lease.blocks === 1 ? "block" : "blocks"}
          </span>
          <span
            className="d-lease-clock"
            data-low={!ended && blockRunningOut(remaining) ? "" : undefined}
          >
            {ended ? "ended" : formatBlockClock(remaining)}
          </span>
        </div>
      ) : null}

      {!ended && waiting ? (
        <p className="d-hint" data-tone="warn">
          The goal has a spend outstanding, so the renewal cannot be requested yet — the vault
          takes one spend at a time per goal. Waiting, with the block boundary as the deadline.
        </p>
      ) : null}

      {!ended && due ? (
        <p className="d-hint">
          Renewing now, a full decision cycle before the block ends. That lead is what makes a
          refusal arrive while the machine is still up.
        </p>
      ) : null}

      {done ? (
        (() => {
          const view = describeLeaseEnding(done);
          return (
            <div className="d-outcome" data-tone={view.tone} role="status">
              <span className="d-outcome-head">{view.head}</span>
              <p className="d-outcome-body">{view.body}</p>
            </div>
          );
        })()
      ) : null}

      {lease?.credentialSha256 ? (
        <p className="d-lease-cred">
          credential sha256 {lease.credentialSha256.slice(0, 18)}…
          {lease.rotated ? " (rotated — the previous one stopped working)" : ""}
        </p>
      ) : null}
    </section>
  );
}
