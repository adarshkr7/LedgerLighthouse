/**
 * Infinite horizontal strip.
 *
 * The loop is the usual two-identical-halves trick: the track holds the items
 * twice and translates by exactly -50%, so the second copy is under the
 * cursor at the instant the first scrolls out and there is no seam.
 *
 * That trick has one precondition which is easy to miss — *each half must be
 * at least as wide as the container*. Six short wordmarks are not, and the
 * result is a strip that runs correctly for a moment and then drags an
 * obvious gap of empty track across the screen. So each half repeats the item
 * list as many times as it takes to cover the container, measured rather than
 * guessed: guessing means picking a number that happens to work at 1440 and
 * breaks on an ultrawide.
 *
 * `reps` converges in a single extra render — the measurement divides out the
 * current repeat count to recover the width of one pass, which does not
 * change when the count does.
 *
 * Duration scales with `reps` so the strip travels at the same pixels-per-
 * second whatever the viewport does to the repeat count. Without that, a
 * wider screen would silently speed the marquee up.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MarqueeProps {
  readonly items: readonly ReactNode[];
  /** Seconds for one pass of the item list. Longer is calmer. */
  readonly duration?: number;
  /** Run right-to-left instead. */
  readonly reverse?: boolean;
  readonly className?: string | undefined;
}

export function Marquee({ items, duration = 14, reverse = false, className }: MarqueeProps) {
  const host = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [reps, setReps] = useState(1);

  useEffect(() => {
    const wrap = host.current;
    const first = row.current;
    if (!wrap || !first) return;

    const measure = () => {
      // Width of a single pass of `items`, independent of how many passes are
      // currently rendered.
      const unit = first.scrollWidth / reps;
      if (unit <= 0) return;
      const need = Math.max(1, Math.ceil(wrap.clientWidth / unit));
      if (need !== reps) setReps(need);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [reps, items.length]);

  const pass = (hidden: boolean, ref?: React.RefObject<HTMLDivElement | null>) => (
    <div className="fx-marquee-row" ref={ref} aria-hidden={hidden ? "true" : undefined}>
      {Array.from({ length: reps }, (_, r) =>
        items.map((item, i) => (
          <span className="fx-marquee-item" key={r + "-" + i}>
            {item}
          </span>
        )),
      )}
    </div>
  );

  return (
    <div ref={host} className={className ? "fx-marquee " + className : "fx-marquee"}>
      <div
        className="fx-marquee-track"
        style={{
          animationDuration: duration * reps + "s",
          animationDirection: reverse ? "reverse" : "normal",
        }}
      >
        {/* Only the first half is measured, and only the second is hidden from
            assistive tech — it is the same list read twice. */}
        {pass(false, row)}
        {pass(true)}
      </div>
    </div>
  );
}
