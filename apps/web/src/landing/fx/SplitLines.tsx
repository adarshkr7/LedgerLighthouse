/**
 * Masked line reveal — each line of a headline rises out of its own clip.
 *
 * This is the entrance the reference site opens with, and the reason it works
 * is the mask: the line translates from fully below its own box while the box
 * itself hides the overflow, so the type appears to be uncovered rather than
 * flown in. A plain `translateY + opacity` produces a line sliding over
 * whitespace, which is a different, cheaper-looking thing.
 *
 * Note for callers: `.fx-line` is a block, so the lines *look* separated, but
 * they concatenate in `textContent` — which is what assistive tech walks. Any
 * line followed by another should therefore end with a space, or "What's in a"
 * + "bound." is announced as "What's in abound."
 *
 * Lines are passed in explicitly rather than measured from a wrapped
 * paragraph. Measuring means reading layout after paint, re-splitting on every
 * resize, and getting it wrong for one frame on load; for headline copy that
 * is authored with intentional breaks anyway, the array *is* the design.
 */

import type { ElementType, ReactNode } from "react";

import { useInView } from "./useInView.js";

export interface SplitLinesProps {
  /** One entry per visual line. Nodes are allowed so a line can carry emphasis. */
  readonly lines: readonly ReactNode[];
  readonly as?: ElementType;
  readonly className?: string;
  /** Delay before the first line, in ms. */
  readonly delay?: number;
  /** Gap between consecutive lines, in ms. */
  readonly stagger?: number;
}

export function SplitLines({
  lines,
  as: Tag = "h2",
  className,
  delay = 0,
  stagger = 90,
}: SplitLinesProps) {
  const [ref, seen] = useInView<HTMLElement>({ threshold: 0.25 });

  return (
    <Tag ref={ref} className={className} data-seen={seen ? "" : undefined}>
      {lines.map((line, i) => (
        // Index keys are correct here: these are fixed, authored lines that
        // never reorder or filter.
        <span className="fx-line" key={i}>
          <span className="fx-line-in" style={{ transitionDelay: `${delay + i * stagger}ms` }}>
            {line}
          </span>
        </span>
      ))}
    </Tag>
  );
}
