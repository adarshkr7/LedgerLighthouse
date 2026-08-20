/**
 * Masked line reveal for prose — same effect as `SplitLines`, but the lines
 * are measured rather than authored.
 *
 * `SplitLines` takes the breaks as a prop, which is right for a display
 * headline: where "Don't trust / the AI." breaks is a typographic decision, not
 * a consequence of the viewport. It is wrong for a paragraph. Breaks authored
 * against a 1440px layout survive nowhere else — at 375px the first line wraps
 * again and leaves a one-word orphan sitting under it, which is exactly the
 * ragged edge the effect is supposed to be showing off.
 *
 * So this measures. The text is rendered flat, a `Range` walks it a character
 * at a time collecting the `top` of each character's rect, and a change in
 * `top` is a line break — the browser's own break, wherever it decided to put
 * it. Those indices become the spans.
 *
 * ## Why this is cheap enough
 *
 * It looks like a lot of layout reads, and it would be if it ran per frame.
 * It runs on mount and on resize, over strings of ~120 characters, inside a
 * layout effect that has already forced the one reflow it needs. Everything
 * after that is a plain CSS transition.
 *
 * ## The two-pass render
 *
 * Measuring requires the flat text; displaying requires the spans. So the
 * component renders flat, measures in `useLayoutEffect`, then re-renders
 * split — before paint, so nothing flashes. On resize it drops back to flat
 * and repeats, which is invisible because the flat text and the split text
 * occupy the identical box.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ElementType } from "react";

import { useInView } from "./useInView.js";

export interface SplitTextProps {
  readonly text: string;
  readonly as?: ElementType;
  readonly className?: string | undefined;
  /** Delay before the first line, in ms. */
  readonly delay?: number;
  /** Gap between consecutive lines, in ms. */
  readonly stagger?: number;
}

export function SplitText({
  text,
  as: Tag = "p",
  className,
  delay = 0,
  stagger = 70,
}: SplitTextProps) {
  const [ref, seen] = useInView<HTMLElement>({ threshold: 0.25 });
  const host = useRef<HTMLElement | null>(null);
  const [lines, setLines] = useState<readonly string[] | null>(null);

  useLayoutEffect(() => {
    // Only measure while flat — once split, the text node this walks is gone.
    if (lines !== null) return;
    const el = host.current;
    if (!el) return;

    const node = el.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;

    const range = document.createRange();
    const out: string[] = [];
    let start = 0;
    let top: number | null = null;

    for (let i = 0; i < text.length; i += 1) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getBoundingClientRect();
      // A collapsed rect is a character the browser did not lay out — the
      // space a line wrapped on. It carries no position, so it cannot start a
      // line, and reading its `top` as a break would split one line in two.
      if (rect.height === 0) continue;

      if (top === null) {
        top = rect.top;
      } else if (Math.abs(rect.top - top) > 1) {
        out.push(text.slice(start, i));
        start = i;
        top = rect.top;
      }
    }
    out.push(text.slice(start));

    setLines(out.map((line) => line.trim()));
  }, [lines, text]);

  // A width change invalidates every break. Dropping to flat re-runs the
  // measurement above; the effect owns re-splitting, so this only has to
  // decide *when*.
  useEffect(() => {
    const el = host.current;
    if (!el) return;

    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      setLines(null);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <Tag
      ref={(el: HTMLElement | null) => {
        host.current = el;
        ref.current = el;
      }}
      className={className}
      data-seen={seen ? "" : undefined}
    >
      {lines === null
        ? text
        : lines.map((line, i) => (
            // Index keys: these are positional line slots, and the whole list
            // is replaced at once on every re-measure.
            <span className="fx-line" key={i}>
              <span
                className="fx-line-in"
                style={{ transitionDelay: `${delay + i * stagger}ms` }}
              >
                {line}
              </span>
            </span>
          ))}
    </Tag>
  );
}
