/**
 * Right-column panels: the verdict, the structured/attacker split, the
 * guarantee grid, and the evidence drawer. All read-only projections of the
 * event stream — none of them read the chain or hold state beyond a toggle.
 */

import { useState } from "react";

import { Card, Copyable, Field, TxLink, truncate } from "./primitives.js";
import { ORCHESTRATOR_URL } from "../lib/config.js";
import type { PaymentEvent, RunResult } from "../lib/run.js";

function find<T extends PaymentEvent["type"]>(
  events: readonly PaymentEvent[],
  type: T,
): Extract<PaymentEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as Extract<PaymentEvent, { type: T }> | undefined;
}

/**
 * The verdict, stated in full.
 *
 * This is the payoff of the entire demo and it previously rendered as the word
 * "bounced" in a caption. What a viewer wants to know at this moment is where
 * the money went, so each branch says that explicitly — especially the rejected
 * one, where the interesting fact is that the agent *did* approve and it made
 * no difference.
 */
export function Outcome({
  result,
  events,
}: {
  result: RunResult | undefined;
  events: readonly PaymentEvent[];
}) {
  if (!result) return null;

  const settled = find(events, "settled");
  const refused = find(events, "signer-refused");

  const view = ((): { tone: "real" | "false" | "flux"; head: string; body: string } => {
    switch (result.kind) {
      case "paid": {
        const simulated = settled?.settlement.simulated === true;
        return {
          tone: "real",
          head: "Approved · settled",
          body: simulated
            ? "The confidential policy approved this spend and the payment authorization validated. Settlement was stubbed, so no USDC moved — fund the payer with test USDC to settle for real."
            : "The confidential policy approved this spend, the signer authorized it from the finalized on-chain record, and the resource returned.",
        };
      }
      case "policy-rejected":
        return {
          tone: "false",
          head: "Blocked by confidential policy",
          body:
            "The agent read the vendor's text and approved this payment. It made no difference. " +
            "The encrypted budget refused the spend, no USDC moved" +
            (refused ? ", and the signer refused to produce an authorization." : ", and the signer was never asked."),
        };
      case "decision-unavailable":
        return {
          tone: "flux",
          head: "Decision unavailable",
          body: `The debit committed on chain but the reveal did not arrive within the polling bound (${result.attempts} attempts, ${(result.elapsedMs / 1000).toFixed(1)}s). This is a distinct state from "rejected" and is reported rather than swallowed.`,
        };
      case "free":
        return {
          tone: "real",
          head: "No payment required",
          body: "The resource returned without a 402, so no spend was requested.",
        };
      case "failed":
        return { tone: "false", head: "Run failed", body: result.reason };
    }
  })();

  return (
    <div className="d-outcome" data-tone={view.tone} role="status">
      <span className="d-outcome-head">{view.head}</span>
      <p className="d-outcome-body">{view.body}</p>
    </div>
  );
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
        <div className="d-split-pane" data-tone="safe">
          <span className="d-label">Structured — what the policy acts on</span>
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

export function EvidenceDrawer({
  events,
  goalId,
}: {
  events: readonly PaymentEvent[];
  goalId: string | undefined;
}) {
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
          {count === 0 ? "nothing yet" : open ? "hide" : `show ${count}`}
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

          <TraceDownload goalId={goalId} />
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Pulls the run's trace and hands it over as a file.
 *
 * The trace is the artefact that makes the whole run checkable by someone who
 * was not in the room, and until now the only way to get it was a curl command
 * buried in the README. The verify command is shown alongside because the file
 * on its own does not tell you what to do with it.
 */
function TraceDownload({ goalId }: { goalId: string | undefined }) {
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");

  async function download() {
    if (!goalId) return;
    setState("working");
    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/traces/${goalId}`);
      if (!response.ok) throw new Error(String(response.status));
      const blob = new Blob([await response.text()], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `trace-goal-${goalId}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="d-advanced">
      <button
        type="button"
        className="d-btn"
        data-kind="outline"
        style={{ width: "100%" }}
        disabled={!goalId || state === "working"}
        onClick={() => void download()}
      >
        {state === "working" ? "Fetching…" : "Download trace"}
      </button>
      {state === "failed" ? (
        <p className="d-caption">No trace yet for this goal — run a request first.</p>
      ) : (
        <>
          <p className="d-caption">Verify it independently — the file and a public RPC are enough:</p>
          <pre className="d-code">pnpm --filter @ntux402/trace run verify -- trace.json</pre>
        </>
      )}
    </div>
  );
}
