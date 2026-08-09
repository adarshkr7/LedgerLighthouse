/**
 * The run, rendered as it happens.
 *
 * Two things are given deliberate visual weight, because they are the two the
 * demo turns on: the vendor's description (attacker-controlled, marked as such)
 * and the agent's reasoning (which, on the malicious run, visibly complies with
 * it). Everything else is reported plainly.
 */

import { Badge } from "./Step.js";
import { explorer, formatUsdc } from "../lib/config.js";
import type { PaymentEvent } from "../lib/run.js";

export function RunLog({ events }: { events: readonly PaymentEvent[] }) {
  if (events.length === 0) {
    return <p className="hint">Nothing yet. Start a run above.</p>;
  }
  return (
    <div className="log">
      {events.map((event, i) => (
        <Entry key={i} event={event} />
      ))}
    </div>
  );
}

function Entry({ event }: { event: PaymentEvent }) {
  switch (event.type) {
    case "request":
      return (
        <div className="log-entry">
          <span className="label">request</span>
          GET {event.url}
          {event.attempt > 1 ? " — retried with X-PAYMENT" : ""}
        </div>
      );

    case "payment-required":
      return (
        <div className="log-entry">
          <span className="label">402 payment required</span>
          {formatUsdc(BigInt(event.terms.amount))} USDC → <code>{event.terms.payTo}</code>
          <p className="vendor-text">
            <strong>Vendor description — attacker-controlled.</strong> The policy check never
            reads this. The agent does, which is the point.
            <br />
            <br />
            {event.terms.description}
          </p>
        </div>
      );

    case "terms-rejected":
      return (
        <div className="log-entry">
          <span className="label">402 rejected by the parser</span>
          {event.error}
        </div>
      );

    case "agent-reasoning":
      return (
        <div className="log-entry reasoning">
          <span className="label">
            agent reasoning — {event.source === "llm" ? "live model" : "scripted stand-in"}
          </span>
          <pre>{event.reasoning}</pre>
          <div style={{ marginTop: "0.6rem" }}>
            <Badge tone={event.decidedToRequest ? "pending" : "neutral"}>
              {event.decidedToRequest ? "requesting authorization" : "declining"}
            </Badge>
          </div>
        </div>
      );

    case "spend-requested":
      return (
        <div className="log-entry">
          <span className="label">requestSpend committed — seq {event.spend.seq}</span>
          <dl className="facts">
            <dt>decision handle</dt>
            <dd title={event.spend.decisionHandle}>{event.spend.decisionHandle}</dd>
            <dt>terms hash</dt>
            <dd title={event.spend.termsHash}>{event.spend.termsHash}</dd>
            <dt>validity</dt>
            <dd>
              {event.spend.validAfter}..{event.spend.validBefore} (frozen)
            </dd>
            <dt>commit</dt>
            <dd>
              <a href={explorer.tx(event.spend.commitTx)} target="_blank" rel="noreferrer">
                {event.spend.commitTx}
              </a>
            </dd>
          </dl>
          <p className="hint">
            The debit was applied unconditionally in this transaction. The outcome is already
            determined and not yet knowable — to anyone, including the orchestrator.
          </p>
        </div>
      );

    case "reveal-polled":
      return (
        <div className="log-entry">
          <span className="label">Inco decision retrieved</span>
          <Badge tone={event.approved ? "approve" : "reject"}>
            {event.approved ? "approve" : "reject"}
          </Badge>{" "}
          after {(event.latencyMs / 1000).toFixed(1)}s, {event.attempts} attempt
          {event.attempts === 1 ? "" : "s"}
        </div>
      );

    case "reveal-timeout":
      return (
        <div className="log-entry">
          <span className="label">Inco reveal timed out</span>
          {(event.elapsedMs / 1000).toFixed(1)}s over {event.attempts} attempts. The debit already
          committed — this is not a rejection.
        </div>
      );

    case "decision-finalized":
      return (
        <div className="log-entry">
          <span className="label">finalizeDecision</span>
          <Badge tone={event.approved ? "approve" : "reject"}>
            {event.approved ? "approved" : "rejected"}
          </Badge>{" "}
          <a href={explorer.tx(event.txHash)} target="_blank" rel="noreferrer">
            {event.txHash}
          </a>
          <p className="hint">
            Verified against the handle the vault stored, not the one the caller supplied.
          </p>
        </div>
      );

    case "signer-refused":
      return (
        <div className="log-entry">
          <span className="label">signer refused — {event.status}</span>
          {event.reason}
        </div>
      );

    case "signed":
      return (
        <div className="log-entry">
          <span className="label">authorization signed</span>
          {formatUsdc(BigInt(event.value))} USDC, nonce <code>{event.nonce}</code>
          <p className="hint">
            Every field read from the finalized on-chain record. The signer was told only
            (goalId, seq).
          </p>
        </div>
      );

    case "settled":
      return (
        <div className="log-entry">
          <span className="label">facilitator</span>
          {event.settlement.simulated ? (
            <>
              <Badge tone="pending">stub</Badge> payload accepted, no money moved
            </>
          ) : event.settlement.success ? (
            <>
              <Badge tone="approve">settled</Badge>{" "}
              {event.settlement.transaction ? (
                <a href={explorer.tx(event.settlement.transaction)} target="_blank" rel="noreferrer">
                  {event.settlement.transaction}
                </a>
              ) : null}
              {event.settlement.alreadySettled ? " (already settled — the retry was safe)" : ""}
            </>
          ) : (
            <>
              <Badge tone="reject">failed</Badge> {event.settlement.errorReason}
            </>
          )}
        </div>
      );

    case "response-200":
      return (
        <div className="log-entry">
          <span className="label">200 ok</span>
          {event.fromCache ? "served from cache — no request left the process" : "premium data returned"}
        </div>
      );

    case "failed":
      return (
        <div className="log-entry">
          <span className="label">failed</span>
          {event.reason}
        </div>
      );
  }
}
