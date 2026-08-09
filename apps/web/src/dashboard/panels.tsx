/**
 * Right-column panels: the structured/attacker split, the guarantee grid, the
 * evidence drawer, and the empty state. All read-only projections of the event
 * stream.
 */

import { useState } from "react";

import { Card, Copyable, Field, TxLink, truncate } from "./primitives.js";
import type { PaymentEvent } from "../lib/run.js";

function find<T extends PaymentEvent["type"]>(
  events: readonly PaymentEvent[],
  type: T,
): Extract<PaymentEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as Extract<PaymentEvent, { type: T }> | undefined;
}

/**
 * The two inputs side by side.
 *
 * This is the page's whole argument in one panel: the left pane is the typed
 * projection the policy check acts on, the right is the vendor's free text. The
 * attacker controls only the right, and the right reaches only the model.
 */
export function Comparison({ events }: { events: readonly PaymentEvent[] }) {
  const reasoning = find(events, "agent-reasoning");
  const required = find(events, "payment-required");

  if (!reasoning && !required) return null;

  return (
    <Card title="Model input">
      <div className="d-split">
        <div className="d-split-pane">
          <span className="d-label">What the model saw — structured</span>
          <pre className="d-code">
            {reasoning ? JSON.stringify(reasoning.modelSafeTerms, null, 2) : "—"}
          </pre>
        </div>
        <div className="d-split-pane" data-tone="hostile">
          <span className="d-label">Attacker-controlled text</span>
          <pre className="d-code">{required?.terms.description ?? "—"}</pre>
        </div>
      </div>
      <p className="d-caption">
        Amount, payee and asset come from the schema validator, never from the prose.
      </p>
    </Card>
  );
}

const GUARANTEES = [
  ["Budget remains private", "Stored on chain as an opaque handle."],
  ["Replay protected", "Deterministic nonce; retry cannot double-pay."],
  ["Finalized-record signing", "The signer reads the chain, never the caller."],
  ["Independent loss cap", "The payer holds only what was funded."],
] as const;

export function Guarantees() {
  return (
    <Card title="Guarantees">
      <ul className="d-guarantees">
        {GUARANTEES.map(([title, note]) => (
          <li key={title} className="d-guarantee">
            <span className="d-guarantee-title">{title}</span>
            <span className="d-caption">{note}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function EvidenceDrawer({ events }: { events: readonly PaymentEvent[] }) {
  const [open, setOpen] = useState(false);

  const spend = find(events, "spend-requested");
  const finalized = find(events, "decision-finalized");
  const settled = find(events, "settled");
  const count = [spend, finalized, settled].filter(Boolean).length;

  return (
    <Card>
      <button
        type="button"
        className="d-drawer-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="evidence-body"
      >
        <span className="d-card-title">Evidence</span>
        <span className="d-caption">
          {count === 0 ? "nothing yet" : open ? "hide" : "show"}
        </span>
      </button>

      {open ? (
        <div id="evidence-body" className="d-drawer-body">
          <Field label="Decision handle">
            {spend ? (
              <Copyable value={spend.spend.decisionHandle} display={truncate(spend.spend.decisionHandle)} />
            ) : (
              <span className="d-muted">—</span>
            )}
          </Field>
          <Field label="Terms hash">
            {spend ? (
              <Copyable value={spend.spend.termsHash} display={truncate(spend.spend.termsHash)} />
            ) : (
              <span className="d-muted">—</span>
            )}
          </Field>
          <Field label="Validity window">
            {spend ? (
              <span className="d-mono">
                {spend.spend.validAfter} .. {spend.spend.validBefore}
              </span>
            ) : (
              <span className="d-muted">—</span>
            )}
          </Field>
          <TxLink label="Commit tx" hash={spend?.spend.commitTx} />
          <TxLink label="Finalize tx" hash={finalized?.txHash} />
          <TxLink label="Settlement tx" hash={settled?.settlement.transaction} />
          {settled?.settlement.simulated ? (
            <p className="d-caption">
              Settlement was stubbed — the payload was validated but no USDC moved.
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/** Shown until the first run produces an event. */
export function EmptyState() {
  return (
    <div className="d-empty">
      <svg viewBox="0 0 120 80" width="120" height="80" aria-hidden="true" className="d-empty-art">
        <rect x="6" y="26" width="26" height="28" rx="3" />
        <rect x="47" y="26" width="26" height="28" rx="3" />
        <rect x="88" y="26" width="26" height="28" rx="3" />
        <path d="M32 40h15M73 40h15" />
        <circle cx="60" cy="40" r="5.5" className="d-empty-accent" />
      </svg>
      <p className="d-empty-text">Run a request to watch the confidential authorization flow.</p>
    </div>
  );
}
