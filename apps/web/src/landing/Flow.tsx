/**
 * The workflow diagram — the landing page's centrepiece.
 *
 * The motion is a slow highlight walking the chain — no transforms, no easing
 * curves drawing attention to themselves, just a border and a label brightening
 * for a beat. It stops entirely under `prefers-reduced-motion`, where the first
 * step stays lit so the design still reads.
 *
 * Seven across on a wide screen, stacked below 64rem. It never wraps to a
 * second row: a wrapped chain leaves a connector at the end of each row
 * pointing at nothing, which reads as a broken diagram rather than a folded one.
 */

import { useEffect, useState } from "react";

import {
  AgentIcon,
  KeyIcon,
  LockIcon,
  RecordIcon,
  SettleIcon,
  ShieldIcon,
  WalletIcon,
} from "./icons.js";

export interface FlowStep {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly Icon: typeof WalletIcon;
}

/**
 * Deliberately the real pipeline, in order, with the honest names. A diagram
 * that says "AI decides" where the system says "confidential policy evaluates"
 * would be the one place on this page that oversells.
 */
export const FLOW_STEPS: readonly FlowStep[] = [
  { id: "wallet", label: "User Wallet", note: "Signs once. Never in the loop.", Icon: WalletIcon },
  { id: "goal", label: "Encrypted Goal", note: "Budget encrypted in the browser.", Icon: LockIcon },
  { id: "agent", label: "AI Agent", note: "Reads vendor text. Holds no key.", Icon: AgentIcon },
  { id: "policy", label: "Confidential Policy", note: "Evaluated on Inco.", Icon: ShieldIcon },
  { id: "record", label: "Finalized Record", note: "Decision committed on chain.", Icon: RecordIcon },
  { id: "payer", label: "Ephemeral Payer", note: "Per-goal key, capped funds.", Icon: KeyIcon },
  { id: "settle", label: "x402 Settlement", note: "EIP-3009 on Base Sepolia.", Icon: SettleIcon },
];

/** ~2s per step: slow enough to read, quick enough to see the chain complete. */
const STEP_MS = 2000;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export function Flow() {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const timer = window.setInterval(
      () => setActive((i) => (i + 1) % FLOW_STEPS.length),
      STEP_MS,
    );
    return () => window.clearInterval(timer);
  }, [reduced]);

  return (
    <ol className="flow" aria-label="How a payment moves through the system">
      {FLOW_STEPS.map((step, i) => (
        <li
          key={step.id}
          className="flow-step"
          data-active={i === active ? "true" : undefined}
          // The highlight is decorative; it must not read as selection to AT.
          aria-current={undefined}
        >
          <div className="flow-node">
            <span className="flow-icon">
              <step.Icon />
            </span>
            <span className="flow-text">
              <span className="flow-label">{step.label}</span>
              <span className="flow-note">{step.note}</span>
            </span>
          </div>
          {i < FLOW_STEPS.length - 1 ? <span className="flow-link" aria-hidden="true" /> : null}
        </li>
      ))}
    </ol>
  );
}
