/**
 * Reports the tone of whichever section is currently under the fixed header.
 *
 * The header floats over sections that alternate between ink and bone, so a
 * single fixed colour is wrong for half the page — bone-on-bone is invisible,
 * and that is not a subtle degradation, it is the brand mark and the primary
 * call to action disappearing.
 *
 * Rather than watch scroll position and compare offsets, this collapses the
 * observer root to a *one-pixel band* sitting where the header's midline is:
 * the top margin pushes the root's top edge down to the midline, and the
 * bottom margin pulls its bottom edge up to just below that. Exactly one
 * section can intersect a 1px band, so the callback is unambiguous and fires
 * only at the moment of a crossing — no scroll listener, no rAF, no layout
 * reads on every frame.
 *
 * The band is recomputed on resize because it is expressed in pixels off the
 * viewport height, and `IntersectionObserver` bakes its margins in at
 * construction.
 */

import { useEffect, useState } from "react";

export type Tone = "ink" | "bone";

/** Must match `--gf-header` in landing.css. */
const HEADER_H = 104;

export function useHeaderTone(): Tone {
  // Ink first: the hero is ink, and guessing bone would flash a dark brand
  // mark against the dark hero for one frame on load.
  const [tone, setTone] = useState<Tone>("ink");

  useEffect(() => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>(".gf-sec"));
    if (!sections.length || !("IntersectionObserver" in window)) return;

    let observer: IntersectionObserver | null = null;

    const attach = () => {
      observer?.disconnect();

      const line = HEADER_H / 2;
      const bottom = Math.max(0, window.innerHeight - line - 1);

      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            setTone(entry.target.classList.contains("gf-ink") ? "ink" : "bone");
          }
        },
        { rootMargin: `-${line}px 0px -${bottom}px 0px`, threshold: 0 },
      );

      for (const section of sections) observer.observe(section);
    };

    attach();
    window.addEventListener("resize", attach);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", attach);
    };
  }, []);

  return tone;
}
