/**
 * Glyph Rain — falling streams of characters behind a section.
 *
 * Canvas UI's version lights up the live HTML underneath and surges where the
 * cursor cuts through the columns. Both behaviours are here; what is missing
 * is the WebGL readback of the page, which is replaced by simply sitting the
 * canvas behind the content at low alpha. At the opacity this runs at the
 * difference is not visible, and the section stays readable — which matters
 * more, because there is body copy on top of it.
 *
 * Every column carries its own speed, glyph buffer and head position. The head
 * is drawn brand-orange and the tail fades to bone; the trail is produced by
 * painting a translucent black rectangle each frame rather than clearing, so
 * old glyphs decay instead of blinking out. That one trick is the whole
 * effect, and it costs one `fillRect`.
 */

import { useEffect, useRef } from "react";

import { prefersReducedMotion } from "./useInView.js";

/**
 * Hex digits and a few structural marks. Deliberately not katakana: what falls
 * past a page about ciphertext handles should look like the handles.
 */
const GLYPHS = "0123456789ABCDEF×÷/\\|<>[]{}";

/** Column pitch in CSS pixels. */
const COL_W = 14;

/** Cursor radius within which columns surge, in CSS pixels. */
const SURGE_R = 150;

export function GlyphRain({ className }: { readonly className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = host.current;
    const cv = surface.current;
    if (!wrap || !cv) return;
    // Nothing about this is informational, so reduced motion gets no canvas
    // at all rather than a frozen still of falling rain.
    if (prefersReducedMotion()) return;

    const ctx = cv.getContext("2d", { alpha: false });
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let cols = 0;
    /** Head position of each column, in rows. Fractional; drawn on the floor. */
    let heads: Float32Array = new Float32Array(0);
    /** Fall speed per column, in rows per frame. */
    let speeds: Float32Array = new Float32Array(0);
    let raf = 0;
    let visible = true;
    const pointer = { x: -9999, y: -9999, on: false };

    const rowH = COL_W * 1.35;

    function resize(): void {
      const rect = wrap!.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;

      width = rect.width;
      height = rect.height;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv!.width = Math.round(width * dpr);
      cv!.height = Math.round(height * dpr);
      cv!.style.width = width + "px";
      cv!.style.height = height + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      cols = Math.max(1, Math.ceil(width / COL_W));
      heads = new Float32Array(cols);
      speeds = new Float32Array(cols);
      for (let i = 0; i < cols; i += 1) {
        // Stagger the start so the first frame is already mid-storm rather
        // than a single tidy line marching down from the top edge.
        heads[i] = Math.random() * (height / rowH);
        speeds[i] = 0.18 + Math.random() * 0.5;
      }

      ctx!.fillStyle = "#141314";
      ctx!.fillRect(0, 0, width, height);
    }

    function frame(): void {
      // The trail. Low alpha means glyphs take ~20 frames to disappear.
      ctx!.fillStyle = "rgba(20, 19, 20, 0.09)";
      ctx!.fillRect(0, 0, width, height);
      ctx!.font = '400 ' + COL_W + 'px "Geist Mono", ui-monospace, monospace';
      ctx!.textBaseline = "top";

      for (let i = 0; i < cols; i += 1) {
        const x = i * COL_W;

        let speed = speeds[i] as number;
        if (pointer.on) {
          const dx = x - pointer.x;
          if (Math.abs(dx) < SURGE_R) {
            // Columns near the cursor accelerate. Squared falloff so the
            // surge has a clear centre instead of a wide soft band.
            speed *= 1 + (1 - Math.abs(dx) / SURGE_R) ** 2 * 5;
          }
        }

        let head = (heads[i] as number) + speed;
        if (head * rowH > height + rowH * 6) head = -Math.random() * 12;
        heads[i] = head;

        const y = Math.floor(head) * rowH;
        if (y < -rowH || y > height) continue;

        const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)] as string;

        // The head is the bright one; one glyph behind it carries a dimmer
        // echo so a fast column still reads as a stream and not as a dot.
        ctx!.fillStyle = "rgba(253, 85, 29, 0.85)";
        ctx!.fillText(glyph, x, y);
        ctx!.fillStyle = "rgba(238, 238, 238, 0.22)";
        ctx!.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)] as string, x, y - rowH);
      }

      raf = requestAnimationFrame(frame);
    }

    function start(): void {
      if (raf) return;
      raf = requestAnimationFrame(frame);
    }

    function stop(): void {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    }

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        if (visible) start();
        else stop();
      },
      { threshold: 0 },
    );
    io.observe(wrap);

    const onMove = (e: PointerEvent) => {
      const rect = wrap.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.on = true;
    };
    const onLeave = () => {
      pointer.on = false;
    };
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", onLeave);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div ref={host} className={className ? "fx-rain " + className : "fx-rain"} aria-hidden="true">
      <canvas ref={surface} />
    </div>
  );
}
