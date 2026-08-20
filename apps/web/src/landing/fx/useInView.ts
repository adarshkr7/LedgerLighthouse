/**
 * "Has this element been on screen yet?" — the trigger every entrance on this
 * page hangs off.
 *
 * One-shot by design. Each of the effects downstream (line masks, digit reels,
 * decrypt scrambles) is an *entrance*, not a scrubber: replaying it every time
 * the reader scrolls back up is the single thing that turns motion design into
 * motion sickness. So the observer unobserves on first intersection and the
 * flag never goes false again.
 *
 * The initial value is `false` and the class that hides the element is applied
 * by script, never by the stylesheet — if this module fails to load, content
 * is visible rather than permanently invisible.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

export interface InViewOptions {
  /** Fraction of the element that must be visible. */
  readonly threshold?: number;
  /** Shrinks the viewport so entrances fire slightly before the true edge. */
  readonly rootMargin?: string;
}

export function useInView<T extends HTMLElement = HTMLDivElement>(
  { threshold = 0.15, rootMargin = "0px 0px -10% 0px" }: InViewOptions = {},
): readonly [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // No observer means no entrance choreography — show everything at once
    // rather than gate content behind a feature that isn't there.
    if (!("IntersectionObserver" in window)) {
      setSeen(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setSeen(true);
        observer.disconnect();
      },
      { threshold, rootMargin },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold, rootMargin]);

  return [ref, seen] as const;
}

/** True when the reader has asked the OS for less movement. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
