/**
 * Lenis-backed smooth scrolling, scoped to whichever component mounts it.
 *
 * The landing page is the thing a demo recording scrolls through, and a raw
 * wheel event moves the viewport in discrete ~100px jolts. On a screen that
 * reads as stutter; on a 60fps capture it reads as broken. Lenis intercepts
 * the wheel and interpolates the real scroll position toward the target, so
 * every frame of the recording lands somewhere different.
 *
 * It drives *native* scroll (`window.scrollY`), not a transform on a wrapper.
 * That matters here: the landing page's entrance reveals are an
 * IntersectionObserver, position/sticky is doing the nav, and both keep
 * working untouched because the page really is scrolling.
 *
 * Lifetime is the mounting component's. The console (`App.tsx`) is a dense
 * operational surface where an input-lagging scroll would be a liability
 * rather than a flourish, so destroying on unmount is the point, not just
 * hygiene: leave the landing page and the wheel goes back to native.
 *
 * Reduced motion needs no branch here — Lenis's own `respectReducedMotion`
 * defaults to on, which pins `lerp` to 1 (scroll tracks the device exactly)
 * and makes programmatic scrolls instant.
 */

import { useCallback, useEffect, useRef } from "react";
import Lenis from "lenis";

// `html.lenis { height: auto }` and the `[data-lenis-prevent]` escape hatches.
// Shipped by the package; there is no reason to transcribe it into our sheet.
import "lenis/dist/lenis.css";

/** Scrolls an element into view by `id`. No-op if nothing has that id. */
export type ScrollToId = (id: string) => void;

export function useSmoothScroll(): ScrollToId {
  const lenis = useRef<Lenis | null>(null);

  useEffect(() => {
    const instance = new Lenis({
      // Lenis runs its own rAF loop. One less thing for us to cancel, and it
      // stops itself on `destroy()`.
      autoRaf: true,
      // Slightly heavier than the 0.1 default: a longer tail is what makes a
      // recorded scroll look deliberate instead of twitchy.
      lerp: 0.085,
      // A wheel notch covers a little less ground than the OS would give it,
      // for the same reason.
      wheelMultiplier: 0.9,
    });
    lenis.current = instance;

    return () => {
      instance.destroy();
      lenis.current = null;
    };
  }, []);

  return useCallback((id) => {
    const target = document.getElementById(id);
    if (!target) return;

    const instance = lenis.current;
    if (!instance) {
      // Before the effect has run, or after it has torn down. `scroll-margin-top`
      // is honoured by the platform here, so the nav offset comes for free.
      target.scrollIntoView({ block: "start" });
      return;
    }

    /*
     * Lenis measures to the element's raw offset and knows nothing about
     * `scroll-margin-top`, so a target under the sticky nav would land half
     * hidden. Reading the computed value back off the element keeps the
     * clearance defined in exactly one place — `.lp-section` in landing.css —
     * including at the breakpoint where the nav changes height.
     */
    const clearance = Number.parseFloat(getComputedStyle(target).scrollMarginTop);
    instance.scrollTo(target, {
      offset: Number.isFinite(clearance) ? -clearance : 0,
      duration: 1.1,
    });
  }, []);
}
