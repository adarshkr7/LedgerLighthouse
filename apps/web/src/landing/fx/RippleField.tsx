/**
 * Ripple — expanding rings from every click, over whatever this wraps.
 *
 * Canvas UI's version refracts the live page like a pond surface. Refraction
 * needs the page as a texture, which needs WebGL; what survives without it is
 * the ring itself, drawn as a stroked circle whose radius grows and whose
 * alpha and line width fall off together. Drawn *over* the content at low
 * alpha rather than distorting it, so text underneath stays crisp and
 * selectable — which on a call-to-action is the correct trade.
 *
 * The two ring colours are brand orange and ink, which is a bet on this only
 * ever wrapping a bone section — the call to action. Wrapping an ink section
 * would need the ink ring swapped for bone, and that is the point at which
 * this should take a `tone` prop rather than grow a second hard-coded pair.
 *
 * Ripples are pooled in a plain array and spliced out on expiry. The rAF loop
 * only runs while at least one is alive, so an untouched section costs
 * nothing.
 */

import { useEffect, useRef, type ReactNode } from "react";

import { prefersReducedMotion } from "./useInView.js";

/** Lifetime of one ring, in ms. */
const LIFE = 1400;

/** How far a ring travels, as a fraction of the wrapper's diagonal. */
const REACH = 0.65;

interface Ring {
  readonly x: number;
  readonly y: number;
  readonly born: number;
}

export function RippleField({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = host.current;
    const cv = surface.current;
    if (!wrap || !cv) return;
    if (prefersReducedMotion()) return;

    const ctx = cv.getContext("2d", { alpha: true });
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let raf = 0;
    const rings: Ring[] = [];

    function resize(): void {
      const rect = wrap!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv!.width = Math.round(width * dpr);
      cv!.height = Math.round(height * dpr);
      cv!.style.width = width + "px";
      cv!.style.height = height + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function frame(now: number): void {
      ctx!.clearRect(0, 0, width, height);

      const max = Math.hypot(width, height) * REACH;

      for (let i = rings.length - 1; i >= 0; i -= 1) {
        const ring = rings[i] as Ring;
        const t = (now - ring.born) / LIFE;
        if (t >= 1) {
          rings.splice(i, 1);
          continue;
        }

        // Ease-out on the radius, linear-ish on the fade. The ring leaps out
        // and then relaxes, which is what water does; a linear radius reads
        // like a loading spinner.
        const eased = 1 - (1 - t) ** 3;
        const r = eased * max;

        ctx!.beginPath();
        ctx!.arc(ring.x, ring.y, r, 0, Math.PI * 2);
        ctx!.lineWidth = Math.max(0.5, 2.5 * (1 - t));
        ctx!.strokeStyle = "rgba(253, 85, 29, " + (0.5 * (1 - t)).toFixed(3) + ")";
        ctx!.stroke();

        // A second ring a beat behind the first, so a single click reads as a
        // disturbance rather than as one tidy circle.
        if (t > 0.12) {
          const t2 = t - 0.12;
          ctx!.beginPath();
          ctx!.arc(ring.x, ring.y, (1 - (1 - t2) ** 3) * max, 0, Math.PI * 2);
          ctx!.lineWidth = Math.max(0.5, 1.4 * (1 - t2));
          ctx!.strokeStyle = "rgba(20, 19, 20, " + (0.22 * (1 - t2)).toFixed(3) + ")";
          ctx!.stroke();
        }
      }

      if (rings.length) raf = requestAnimationFrame(frame);
      else raf = 0;
    }

    const onDown = (e: PointerEvent) => {
      const rect = wrap.getBoundingClientRect();
      rings.push({ x: e.clientX - rect.left, y: e.clientY - rect.top, born: performance.now() });
      // Cap the pool. A reader hammering the section should not be able to
      // put a hundred stroked circles on the compositor.
      if (rings.length > 8) rings.shift();
      if (!raf) raf = requestAnimationFrame(frame);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    wrap.addEventListener("pointerdown", onDown);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      wrap.removeEventListener("pointerdown", onDown);
    };
  }, []);

  return (
    <div ref={host} className={className ? "fx-ripple " + className : "fx-ripple"}>
      {children}
      <canvas ref={surface} aria-hidden="true" />
    </div>
  );
}
