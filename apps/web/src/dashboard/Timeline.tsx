/**
 * Live execution timeline.
 *
 * Derives nine fixed stages from the orchestrator's event stream. The stage list
 * is constant so the shape of the flow is legible before anything has happened —
 * a timeline that grows one row at a time tells you nothing about what is still
 * to come.
 *
 * Durations are measured **here**, on arrival, rather than read from the events:
 * the event contract carries no timestamps and this pass may not change it. The
 * one exception is the confidential evaluation, where the orchestrator reports
 * its own `latencyMs` — that number is authoritative and is used as given.
 */

import { useEffect, useRef } from "react";

import type { PaymentEvent } from "../lib/run.js";

export type StageStatus = "pending" | "active" | "done" | "skipped" | "failed";

export interface Stage {
  readonly id: string;
  readonly label: string;
  readonly status: StageStatus;
  readonly detail?: string;
  readonly ms?: number;
}

const STAGE_IDS = [
  "402",
  "summary",
  "commit",
  "evaluate",
  "reveal",
  "finalize",
  "sign",
  "settle",
  "resource",
] as const;

const LABELS: Record<(typeof STAGE_IDS)[number], string> = {
  "402": "402 received",
  summary: "Structured summary",
  commit: "requestSpend committed",
  evaluate: "Confidential evaluation",
  reveal: "Reveal available",
  finalize: "finalizeDecision",
  sign: "Authorization signed",
  settle: "Settlement confirmed",
  resource: "Resource returned",
};

function has(events: readonly PaymentEvent[], type: PaymentEvent["type"]): boolean {
  return events.some((e) => e.type === type);
}

function find<T extends PaymentEvent["type"]>(
  events: readonly PaymentEvent[],
  type: T,
): Extract<PaymentEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as Extract<PaymentEvent, { type: T }> | undefined;
}

/**
 * Maps the event stream onto the fixed stage list.
 *
 * A rejected spend is the important case: the run legitimately stops after
 * `finalizeDecision`, so the last three stages are **skipped**, not pending and
 * not failed. Showing them as still-in-progress would misrepresent a bounce as
 * a hang.
 */
export function deriveStages(events: readonly PaymentEvent[], running: boolean): Stage[] {
  const reveal = find(events, "reveal-polled");
  const finalized = find(events, "decision-finalized");
  const rejected = finalized ? !finalized.approved : false;
  const timedOut = has(events, "reveal-timeout");
  const refused = has(events, "signer-refused");
  const failed = has(events, "failed");

  const reached: Record<string, boolean> = {
    "402": has(events, "payment-required"),
    summary: has(events, "agent-reasoning"),
    commit: has(events, "spend-requested"),
    evaluate: reveal !== undefined || timedOut,
    reveal: reveal !== undefined,
    finalize: finalized !== undefined,
    sign: has(events, "signed"),
    settle: has(events, "settled"),
    resource: events.some((e) => e.type === "response-200"),
  };

  const terminalAfter = rejected || timedOut || refused ? "finalize" : undefined;

  return STAGE_IDS.map((id, i) => {
    let status: StageStatus = reached[id] ? "done" : "pending";

    if (!reached[id]) {
      // Everything past a bounce is skipped: the run ended correctly here.
      const terminalIndex = terminalAfter ? STAGE_IDS.indexOf(terminalAfter) : -1;
      if (terminalIndex >= 0 && i > terminalIndex) status = "skipped";
      else if (failed) status = "skipped";
      else if (running) {
        const firstUnreached = STAGE_IDS.findIndex((s) => !reached[s]);
        if (i === firstUnreached) status = "active";
      }
    }

    if (id === "finalize" && rejected) status = "failed";
    if (id === "evaluate" && timedOut) status = "failed";

    const stage: Stage = { id, label: LABELS[id], status };
    return withDetail(stage, events, reveal, finalized);
  });
}

function withDetail(
  stage: Stage,
  events: readonly PaymentEvent[],
  reveal: Extract<PaymentEvent, { type: "reveal-polled" }> | undefined,
  finalized: Extract<PaymentEvent, { type: "decision-finalized" }> | undefined,
): Stage {
  switch (stage.id) {
    case "402": {
      const e = find(events, "payment-required");
      return e ? { ...stage, detail: `${fmt(e.terms.amount)} USDC` } : stage;
    }
    case "commit": {
      const e = find(events, "spend-requested");
      return e ? { ...stage, detail: `seq ${e.spend.seq}` } : stage;
    }
    case "evaluate":
      // Reported by the orchestrator, not measured here.
      return reveal ? { ...stage, ms: reveal.latencyMs } : stage;
    case "reveal":
      return reveal ? { ...stage, detail: reveal.approved ? "approve" : "reject" } : stage;
    case "finalize":
      return finalized ? { ...stage, detail: finalized.approved ? "approved" : "rejected" } : stage;
    case "sign": {
      const e = find(events, "signed");
      return e ? { ...stage, detail: `${fmt(e.value)} USDC` } : stage;
    }
    case "settle": {
      const e = find(events, "settled");
      if (!e) return stage;
      return { ...stage, detail: e.settlement.simulated ? "stub" : "on chain" };
    }
    default:
      return stage;
  }
}

function fmt(atomic: string): string {
  const n = BigInt(atomic);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "") || "0";
  return `${whole}.${frac}`;
}

export function Timeline({
  events,
  running,
}: {
  events: readonly PaymentEvent[];
  running: boolean;
}) {
  const stages = deriveStages(events, running);

  // First-sighting timestamps, kept in a ref so measuring never triggers a
  // render. Cleared whenever a run restarts (events reset to empty).
  const stamps = useRef(new Map<string, number>());
  const previousCount = useRef(0);

  useEffect(() => {
    if (events.length === 0) {
      stamps.current.clear();
      previousCount.current = 0;
      return;
    }
    previousCount.current = events.length;
  }, [events.length]);

  const now = Date.now();
  for (const stage of stages) {
    if (stage.status === "done" && !stamps.current.has(stage.id)) {
      stamps.current.set(stage.id, now);
    }
  }

  const first = stamps.current.size > 0 ? Math.min(...stamps.current.values()) : undefined;

  return (
    <ol className="d-timeline">
      {stages.map((stage) => {
        const at = stamps.current.get(stage.id);
        const elapsed =
          stage.ms !== undefined
            ? `${(stage.ms / 1000).toFixed(1)}s`
            : at !== undefined && first !== undefined && at > first
              ? `+${((at - first) / 1000).toFixed(1)}s`
              : undefined;

        return (
          <li key={stage.id} className="d-tl-item" data-status={stage.status}>
            <span className="d-tl-marker" aria-hidden="true" />
            <span className="d-tl-label">{stage.label}</span>
            {stage.detail ? <span className="d-tl-detail">{stage.detail}</span> : null}
            <span className="d-tl-time">{elapsed ?? ""}</span>
          </li>
        );
      })}
    </ol>
  );
}
