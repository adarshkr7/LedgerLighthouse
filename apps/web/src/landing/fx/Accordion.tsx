/**
 * Single-open accordion, for the questions section.
 *
 * Built on buttons and `aria-expanded` rather than `<details>`: `<details>`
 * cannot animate its own height in any browser this app targets, and the
 * open/close here is the section's only motion. The panel is measured off its
 * own `scrollHeight` and driven through an explicit pixel height, which is the
 * one reliable way to transition to intrinsic content height.
 *
 * Single-open is deliberate. These answers are three lines each; letting them
 * all sit open at once turns a scannable index into a wall, and the reader
 * loses the thing the accordion was for.
 */

import { useId, useLayoutEffect, useRef, useState } from "react";

export interface AccordionItem {
  readonly q: string;
  readonly a: string;
}

export function Accordion({ items }: { readonly items: readonly AccordionItem[] }) {
  const [open, setOpen] = useState<number | null>(0);
  const base = useId();

  return (
    <div className="ac">
      {items.map((item, i) => (
        <AccordionRow
          key={item.q}
          id={base + "-" + i}
          index={i}
          item={item}
          open={open === i}
          // Clicking the open row closes it. A control that only ever opens
          // is a control the reader cannot undo.
          onToggle={() => setOpen((cur) => (cur === i ? null : i))}
        />
      ))}
    </div>
  );
}

function AccordionRow({
  id,
  index,
  item,
  open,
  onToggle,
}: {
  readonly id: string;
  readonly index: number;
  readonly item: AccordionItem;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  /*
   * Measured in a layout effect so the first open of a row that was never
   * rendered at height still transitions — reading `scrollHeight` after paint
   * would give one frame at the wrong size.
   */
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    setHeight(el.scrollHeight);

    // Re-measure when the answer reflows: a font swap or a window resize
    // changes the wrapped line count, and a stale height clips the last line.
    const ro = new ResizeObserver(() => setHeight(el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [item.a]);

  return (
    <div className="ac-row" data-open={open ? "" : undefined}>
      <h3 className="ac-h">
        <button
          type="button"
          className="ac-btn"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
        >
          <span className="ac-n">{String(index + 1).padStart(2, "0")}</span>
          <span className="ac-q">{item.q}</span>
          <span className="ac-sign" aria-hidden="true">
            <i />
            <i />
          </span>
        </button>
      </h3>
      <div
        className="ac-panel"
        id={id}
        role="region"
        style={{ height: open ? height + "px" : "0px" }}
        // Hidden from the reading order while closed, so a screen reader does
        // not walk answers the sighted reader cannot see.
        aria-hidden={open ? undefined : "true"}
      >
        <div className="ac-inner" ref={panel}>
          <p>{item.a}</p>
        </div>
      </div>
    </div>
  );
}
