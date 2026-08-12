/**
 * The payment path, as a numbered exhibition strip.
 *
 * Swiss International Style: flat bordered panels sharing edges, the focused
 * one inverted to solid black — no blur, no scale, no glow. The one departure
 * from pure black/white is the "AI Agent" stage, which flashes the accent red
 * only while focused: that is the one moment the injection actually lands,
 * and red-as-warning is the single legitimate non-CTA use the palette allows.
 * Every other stage inverts in plain black, because certainty needs no colour.
 *
 * The pager is a numbered index row rather than dots, so position is legible
 * at a glance rather than requiring someone to count filled circles.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type StageKind = "user" | "cipher" | "hostile" | "settle";

export interface FlowStep {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly kind: StageKind;
  /** The line that makes this stage matter. Shown only while focused. */
  readonly detail: string;
}

/**
 * Deliberately the real pipeline, in order, with the honest names. A deck that
 * said "AI decides" where the system says "confidential policy evaluates" would
 * be the one place on this page that oversells.
 */
export const FLOW_STEPS: readonly FlowStep[] = [
  {
    id: "wallet",
    label: "User Wallet",
    note: "Signs once. Never in the loop.",
    kind: "user",
    detail: "Three signatures total: open the goal, fund the payer, close it. Nothing during a run.",
  },
  {
    id: "goal",
    label: "Encrypted Goal",
    note: "Budget encrypted in the browser.",
    kind: "cipher",
    detail: "The ciphertext is bound to your address. On chain it is an opaque bytes32 handle.",
  },
  {
    id: "agent",
    label: "AI Agent",
    note: "Reads vendor text. Holds no key.",
    kind: "hostile",
    detail: "This is where the injection lands. The agent can be fully convinced — it holds only a gas key.",
  },
  {
    id: "policy",
    label: "Confidential Policy",
    note: "Evaluated inside a TEE.",
    kind: "cipher",
    detail: "The debit is applied before the answer is knowable, because you cannot branch on a secret.",
  },
  {
    id: "record",
    label: "Finalized Record",
    note: "Decision committed on chain.",
    kind: "cipher",
    detail: "The attestation is verified against the handle the contract stored, not one the caller supplies.",
  },
  {
    id: "payer",
    label: "Ephemeral Payer",
    note: "Key derived in an enclave.",
    kind: "settle",
    detail: "Per goal, holding only what you funded. No operator can extract the key.",
  },
  {
    id: "settle",
    label: "x402 Settlement",
    note: "EIP-3009 on Base Sepolia.",
    kind: "settle",
    detail: "Gasless, single-use, and shaped exactly as the chain froze it.",
  },
];

/** Long enough to read the detail line, short enough to hold attention. */
const DWELL_MS = 3600;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(q.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function Flow() {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState(0);
  const [held, setHeld] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  // Auto-advance, suspended while a pointer is over the deck or focus is inside
  // it — advancing under someone who is reading is the thing that makes a
  // carousel hostile.
  useEffect(() => {
    if (reduced || held) return;
    const t = window.setInterval(() => setActive((i) => (i + 1) % FLOW_STEPS.length), DWELL_MS);
    return () => window.clearInterval(t);
  }, [reduced, held]);

  // Keep the focused card centred. `scrollIntoView` on the element rather than a
  // computed transform, so it stays correct when the cards reflow.
  useEffect(() => {
    const track = trackRef.current;
    const card = track?.children[active] as HTMLElement | undefined;
    if (!track || !card) return;
    const offset = card.offsetLeft - (track.clientWidth - card.clientWidth) / 2;
    track.scrollTo({ left: offset, behavior: reduced ? "auto" : "smooth" });
  }, [active, reduced]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setActive((i) => (i + 1) % FLOW_STEPS.length);
    if (e.key === "ArrowLeft") setActive((i) => (i - 1 + FLOW_STEPS.length) % FLOW_STEPS.length);
  }, []);

  return (
    <div
      className="deck"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={() => setHeld(false)}
    >
      <div className="deck-grid" aria-hidden="true" />

      <p className="deck-counter">
        Stage {String(active + 1).padStart(2, "0")} of {String(FLOW_STEPS.length).padStart(2, "0")}
      </p>

      <div
        className="deck-track"
        ref={trackRef}
        role="group"
        aria-label="How a payment moves through the system"
        tabIndex={0}
        onKeyDown={onKey}
      >
        {FLOW_STEPS.map((step, i) => {
          const distance = Math.abs(i - active);
          return (
            <article
              key={step.id}
              className="deck-card"
              data-stage={step.kind}
              data-focused={i === active ? "true" : undefined}
              // Drives scale, blur and dimming. Clamped, because a card six
              // places away should not be more degraded than one three away.
              style={{ ["--d" as string]: String(Math.min(distance, 3)) }}
              aria-current={i === active ? "step" : undefined}
            >
              <div className="deck-body">
                <p className="deck-kicker">
                  <span className="deck-idx">{String(i + 1).padStart(2, "0")}</span>
                  {step.note}
                </p>
                <h3 className="deck-title">{step.label}</h3>
                <p className="deck-detail">{step.detail}</p>
              </div>
            </article>
          );
        })}
      </div>

      <div className="deck-pager">
        {FLOW_STEPS.map((step, i) => (
          <button
            key={step.id}
            type="button"
            className="deck-num"
            data-on={i === active ? "true" : undefined}
            aria-label={`Stage ${i + 1}: ${step.label}`}
            onClick={() => setActive(i)}
          >
            {String(i + 1).padStart(2, "0")}
          </button>
        ))}
      </div>
    </div>
  );
}
