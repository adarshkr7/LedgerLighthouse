/**
 * The console's dialog.
 *
 * Built on native `<dialog>` + `showModal()` rather than a div and a portal.
 * That one decision buys the whole accessibility contract for free and
 * correctly: focus is trapped inside, the rest of the page goes inert (not
 * merely `aria-hidden`), Escape closes, focus returns to whatever opened it,
 * and the backdrop is a real `::backdrop` rather than a fixed div fighting the
 * stacking context. Every one of those is a bug in the hand-rolled version.
 *
 * The console is a single non-scrolling frame, so a dialog here is not a
 * decoration — it is where everything that would otherwise force the frame to
 * scroll actually lives. Setup, goal detail, guarantees and evidence are all
 * real content; they are simply not what you look at while a run is in flight.
 *
 * Motion matches the landing page: same `--gf-ease-quart`, same short rise.
 * `@starting-style` plus `transition-behavior: allow-discrete` in the
 * stylesheet is what lets a `display: none` element animate in *and* out
 * natively; where that is unsupported the dialog simply appears, which is the
 * correct degradation for a control surface.
 */

import { useEffect, useRef, type ReactNode } from "react";

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  /** Mono kicker above the title — the console's section marker. */
  readonly tag?: string | undefined;
  /** Widens the panel for content that is genuinely tabular. */
  readonly wide?: boolean | undefined;
  readonly children: ReactNode;
}

export function Modal({ open, onClose, title, tag, wide, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // `showModal()` throws if already open, and `close()` on a closed dialog
    // fires a stray `close` event — so both are guarded on the real state of
    // the element rather than on React's idea of it.
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={wide ? "d-modal d-modal-wide" : "d-modal"}
      aria-labelledby={"modal-" + title.replace(/\W+/g, "-")}
      // Escape fires `cancel`, then `close`. Listening to `close` alone would
      // miss nothing, but preventing the default on `cancel` is what stops the
      // element closing itself while React still thinks it is open.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onClose}
      // A click that lands on the dialog element itself — rather than on the
      // inner panel — is a click on the backdrop, since the panel covers the
      // dialog's entire painted area.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="d-modal-panel">
        <header className="d-modal-head">
          <div>
            {tag ? <p className="d-modal-tag">{tag}</p> : null}
            <h2 className="d-modal-title" id={"modal-" + title.replace(/\W+/g, "-")}>
              {title}
            </h2>
          </div>
          <button type="button" className="d-modal-x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M3 3 L13 13 M13 3 L3 13"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>
        {/* The one scrolling region in the console. Long evidence lists and the
            setup flow can exceed the viewport; the frame behind them may not. */}
        <div className="d-modal-body">{children}</div>
      </div>
    </dialog>
  );
}
