/**
 * Model input — the vendor's text, and what the agent did with it.
 *
 * Built on the Beautiful UI selection-actions pattern: the text the model read
 * is rendered as a *highlighted selection*, with a floating pill bar attached
 * beneath its final line. The bar reports state — reading, then the verdict —
 * and carries the one control worth having, a toggle onto the structured
 * projection the policy actually acts on.
 *
 * The pattern earns its place here rather than being borrowed for its own sake.
 * The panel's whole argument is that one span of text reached the model and
 * nothing else did, and a treatment that literally draws a selection around
 * that span makes the boundary visible instead of merely stated.
 *
 * Adapted, not copied: the original is Next.js + Tailwind and imports
 * `iconoir-react` plus two atom components. Icons here are inline, the styling
 * is the local token set, and the shimmer is the shared `t-shimmer` utility.
 *
 * Anchoring is the load-bearing detail. The bar is centred on the full bounds
 * of the selection but sits under its *last line*, so it never covers the text
 * it describes when that text wraps. Measured through `getClientRects()`, and
 * batched into a frame so a resize mid-measure cannot paint an intermediate
 * position.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Card } from "./primitives.js";
import type { PaymentEvent } from "../lib/run.js";

function find<T extends PaymentEvent["type"]>(
  events: readonly PaymentEvent[],
  type: T,
): Extract<PaymentEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as Extract<PaymentEvent, { type: T }> | undefined;
}

export function ModelInput({
  events,
  running,
}: {
  events: readonly PaymentEvent[];
  running: boolean;
}) {
  const reasoning = find(events, "agent-reasoning");
  const required = find(events, "payment-required");

  const [showStructured, setShowStructured] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const [placed, setPlaced] = useState(false);

  const host = useRef<HTMLDivElement>(null);
  const selection = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const frame = useRef<number>(undefined);

  /*
   * Attach beneath the final selected line, centred on the whole selection.
   * rAF-batched: a ResizeObserver can fire several times during a reflow, and
   * setting the anchor from each would paint the bar at intermediate positions.
   */
  const place = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const hostEl = host.current;
      const selEl = selection.current;
      if (!hostEl || !selEl) return;

      const lines = Array.from(selEl.getClientRects());
      const lastLine = lines.at(-1);
      if (!lastLine) return;

      const bounds = selEl.getBoundingClientRect();
      const hostBounds = hostEl.getBoundingClientRect();
      const next = {
        x: Math.round(bounds.left - hostBounds.left + bounds.width / 2),
        y: Math.round(lastLine.bottom - hostBounds.top + 8),
      };

      setAnchor((current) => (current.x === next.x && current.y === next.y ? current : next));
      setPlaced(true);
    });
  }, []);

  useLayoutEffect(place, [place, running, showStructured, required?.terms.description]);

  useEffect(() => {
    const hostEl = host.current;
    if (!hostEl) return;
    const observer = new ResizeObserver(place);
    observer.observe(hostEl);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [place]);

  /*
   * Animate the bar between its two intrinsic widths.
   *
   * Its contents change wholesale — a spinner and a label become a verdict and
   * a toggle — so `width: auto` would snap. Measuring the new intrinsic width
   * and animating from the last one keeps the pill continuous.
   */
  const lastWidth = useRef(0);
  const widthAnim = useRef<Animation>(undefined);
  const mode = running ? "reading" : "verdict";
  const previousMode = useRef(mode);

  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;

    const next = Math.ceil(el.scrollWidth);
    const previous = lastWidth.current || Math.ceil(el.getBoundingClientRect().width);

    if (previousMode.current !== mode && Math.abs(next - previous) > 1) {
      widthAnim.current?.cancel();
      const animation = el.animate(
        [{ width: `${previous}px` }, { width: `${next}px` }],
        { duration: 300, easing: "cubic-bezier(0.23,1,0.32,1)" },
      );
      widthAnim.current = animation;
      animation.onfinish = () => {
        lastWidth.current = next;
        widthAnim.current = undefined;
      };
    } else {
      lastWidth.current = next;
    }
    previousMode.current = mode;
  }, [mode, showStructured]);

  if (!reasoning && !required) return null;

  const description = required?.terms.description ?? "—";
  const complied = reasoning?.decidedToRequest;

  return (
    <Card title="Model input">
      <div className="mi-host" ref={host}>
        <p className="mi-prose">
          <span className="mi-lead">The vendor sent, and the model read: </span>
          <span className="mi-selection" ref={selection}>
            {description}
            {running ? <span className="t-caret" /> : null}
          </span>
        </p>

        <div
          className="mi-anchor"
          style={{
            transform: `translate3d(${anchor.x}px, ${anchor.y}px, 0) translateX(-50%)`,
            opacity: placed ? 1 : 0,
            pointerEvents: placed ? "auto" : "none",
          }}
        >
          <div className="mi-bar" ref={bar} data-mode={mode}>
            {running ? (
              <span className="mi-busy">
                <span className="mi-spinner" aria-hidden="true" />
                <span className="t-shimmer">Reading vendor text…</span>
              </span>
            ) : (
              <>
                <span className="mi-verdict" data-complied={complied ? "" : undefined}>
                  {complied === undefined
                    ? "No agent decision"
                    : complied
                      ? "Agent complied"
                      : "Agent declined"}
                </span>
                {reasoning ? <span className="mi-source">{reasoning.source}</span> : null}
                <span className="mi-sep" aria-hidden="true" />
                <button
                  type="button"
                  className="mi-toggle"
                  aria-expanded={showStructured}
                  onClick={() => setShowStructured((v) => !v)}
                >
                  <BracesIcon />
                  {showStructured ? "Hide structured" : "Structured"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {showStructured && !running ? (
        <div className="mi-structured">
          <span className="d-label">What the policy acts on</span>
          <pre className="d-code">
            {reasoning ? JSON.stringify(reasoning.modelSafeTerms, null, 2) : "—"}
          </pre>
        </div>
      ) : null}

      <p className="d-caption">
        {complied
          ? "The agent was convinced. Amount, payee and asset still came from the schema validator — never from the prose above."
          : "Amount, payee and asset come from the schema validator, never from the prose above."}
      </p>
    </Card>
  );
}

function BracesIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" />
      <path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
    </svg>
  );
}
