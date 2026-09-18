/**
 * The verdict, the guarantee grid, and the evidence list. All read-only
 * projections of the event stream — none of them read the chain or hold state
 * beyond a fetch.
 *
 * `GuaranteeList` and `EvidenceBody` deliberately render *bodies* only: no
 * card, no header, no disclosure toggle. Both now live inside `Modal`, which
 * already supplies the frame and the title, and a panel that draws its own
 * chrome cannot be placed inside another one without doubling every border.
 * The evidence drawer's open/closed state went with the toggle — a dialog is
 * either up or it is not.
 *
 * The attacker-text panel lives in `ModelInput.tsx`, which needs layout
 * measurement these do not.
 */

import { useState } from "react";

import { Copyable, Field, TxLink, truncate } from "./primitives.js";
import { ORCHESTRATOR_URL } from "../lib/config.js";
import type { PaymentEvent, RunResult } from "../lib/run.js";

function find<T extends PaymentEvent["type"]>(
  events: readonly PaymentEvent[],
  type: T,
): Extract<PaymentEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as Extract<PaymentEvent, { type: T }> | undefined;
}

/** Indeterminate work with a known end — a fetch, not a policy evaluation. */
function Spinner() {
  return (
    <svg className="d-spin" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M8 1.5 A 6.5 6.5 0 0 1 14.5 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
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

  const view = ((): { tone: "ok" | "no" | "wait"; head: string; body: string } => {
    switch (result.kind) {
      case "paid": {
        const simulated = settled?.settlement.simulated === true;
        return {
          tone: "ok",
          head: "Approved · settled",
          body: simulated
            ? "The confidential policy approved this spend and the payment authorization validated. Settlement was stubbed, so no USDC moved — fund the payer with test USDC to settle for real."
            : "The confidential policy approved this spend, the signer authorized it from the finalized on-chain record, and the resource returned.",
        };
      }
      case "policy-rejected":
        return {
          tone: "no",
          head: "Blocked by confidential policy",
          body:
            "The agent read the vendor's text and approved this payment. It made no difference. " +
            "The encrypted budget refused the spend, no USDC moved" +
            (refused ? ", and the signer refused to produce an authorization." : ", and the signer was never asked."),
        };
      case "decision-unavailable":
        return {
          tone: "wait",
          head: "Decision unavailable",
          body: `The debit committed on chain but the reveal did not arrive within the polling bound (${result.attempts} attempts, ${(result.elapsedMs / 1000).toFixed(1)}s). This is a distinct state from "rejected" and is reported rather than swallowed.`,
        };
      case "free":
        return {
          tone: "ok",
          head: "No payment required",
          body: "The resource returned without a 402, so no spend was requested.",
        };
      case "failed":
        return { tone: "no", head: "Run failed", body: result.reason };
    }
  })();

  return (
    <div className="d-outcome" data-tone={view.tone} role="status">
      <span className="d-outcome-head">{view.head}</span>
      <p className="d-outcome-body">{view.body}</p>
    </div>
  );
}

const GUARANTEES = [
  ["Budget remains private", "Stored on chain as an opaque handle."],
  ["Replay protected", "Deterministic nonce; retry cannot double-pay."],
  ["Finalized-record signing", "The signer reads the chain, never the caller."],
  ["Independent loss cap", "The payer holds only what was funded."],
] as const;

export function GuaranteeList() {
  return (
    <ul className="d-guarantees">
      {GUARANTEES.map(([title, note]) => (
        <li key={title} className="d-guarantee">
          <span className="d-guarantee-title">{title}</span>
          <span className="d-caption">{note}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * How many of the three evidence artefacts a run has produced so far.
 *
 * Exported because the console shows this count on the button that opens the
 * evidence dialog — a control that opens an empty drawer is a control that
 * wastes a click, and this is what lets the button say so up front.
 */
export function evidenceCount(events: readonly PaymentEvent[]): number {
  return [
    find(events, "spend-requested"),
    find(events, "decision-finalized"),
    find(events, "settled"),
  ].filter(Boolean).length;
}

export function EvidenceBody({
  events,
  goalId,
}: {
  events: readonly PaymentEvent[];
  goalId: string | undefined;
}) {
  const spend = find(events, "spend-requested");
  const finalized = find(events, "decision-finalized");
  const settled = find(events, "settled");

  return (
    <>
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
    </>
  );
}

const NO_TRACE_YET = "No trace yet for this goal — run a request first.";

/**
 * What to tell the viewer when `/traces/:goalId` says no.
 *
 * A refusal and a miss are different problems with different fixes, and only
 * the second one is theirs to solve. A trace is a run record — the model's
 * reasoning, the payees, the amounts — so the orchestrator will not serve one
 * to the network without a credential, and that is an operator setting rather
 * than anything this page can present.
 */
function traceFailure(status: number): string {
  if (status === 404) return NO_TRACE_YET;
  if (status === 401 || status === 403) {
    return (
      "The orchestrator is refusing to release traces to this page. They are run records, so it " +
      "serves them over loopback, or to a caller holding SERVICE_TOKEN — which a browser bundle " +
      "cannot hold. Fetch it from the machine running the service."
    );
  }
  return `The orchestrator answered ${status}.`;
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
  /*
   * Why it failed, not just that it did.
   *
   * This used to report every failure as "no trace yet — run a request first",
   * which was a guess. It is now wrong more often than it is right: the
   * orchestrator refuses to serve traces at all when it is bound to a network
   * interface without a token, and a page told to go run a request would go
   * round that loop forever.
   */
  const [reason, setReason] = useState(NO_TRACE_YET);

  /*
   * Three ways this fails and they are told apart, because the fix differs
   * every time: nobody home, a refusal from a service that is up, or a browser
   * that would not save a file it already had. One `catch` around the lot
   * reported all three as the first guess.
   */
  function fail(why: string) {
    setReason(why);
    setState("failed");
  }

  async function download() {
    if (!goalId) return;
    setState("working");

    let response: Response;
    try {
      response = await fetch(`${ORCHESTRATOR_URL}/traces/${goalId}`);
    } catch {
      fail(`Could not reach the orchestrator at ${ORCHESTRATOR_URL}.`);
      return;
    }

    if (!response.ok) {
      fail(traceFailure(response.status));
      return;
    }

    try {
      const blob = new Blob([await response.text()], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `trace-goal-${goalId}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch {
      fail("The trace arrived, but the browser would not save it.");
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
        {state === "working" ? (
          <span className="d-btn-busy">
            <Spinner />
            Fetching…
          </span>
        ) : (
          "Download trace"
        )}
      </button>
      {state === "failed" ? (
        <p className="d-caption">{reason}</p>
      ) : (
        <>
          <p className="d-caption">Verify it independently — the file and a public RPC are enough:</p>
          <pre className="d-code">pnpm --filter @ntux402/trace run verify -- trace.json</pre>
        </>
      )}
    </div>
  );
}
