/**
 * ASCII Object — an image redrawn as shape-matched ASCII characters.
 *
 * Canvas UI ships this as a WebGL pass that takes a GLB, SVG or bitmap into a
 * studio scene and resolves it to characters. The idea transfers whole; the
 * renderer does not need to. This is Canvas 2D over a single downsampled
 * bitmap, which is the entire reason it can ship here: no `three`, no `ogl`,
 * no GLB loader, no shader compile on first paint — about 200 lines against
 * roughly 900KB of WebGL dependency for a hero image that never rotates.
 *
 * Three things modulate the character grid, in this order:
 *
 *   1. Luminance of the source pixel picks the glyph from a density ramp.
 *      That is the "shape-matched" part — a wordmark stays legible because
 *      denser glyphs land where the source has ink. `invert` decides which
 *      end of the ramp counts as ink; see the prop.
 *   2. A rotating beam sweeps from the brightest cell and lifts everything it
 *      crosses a step or two up the ramp. This is the one piece of motion
 *      that is *about* the product rather than about the effect — the beam is
 *      the thing the product is named for, and here it sweeps the payment
 *      standard the product is built on.
 *   3. The cursor scatters cells radially and brightens them, borrowing the
 *      behaviour of Canvas UI's "Particle Object". Cells spring back on their
 *      own because displacement is computed from live distance rather than
 *      accumulated — there is no state to unwind and nothing to drift.
 *
 * Rendering is gated on visibility and on reduced motion: off screen the rAF
 * loop is cancelled outright, and a reader who asked for less movement gets a
 * single static frame with no loop at all — the beam is parked out of range
 * rather than frozen mid-sweep, so the still frame is the plain mark.
 */

import { useEffect, useRef } from "react";

import { prefersReducedMotion } from "./useInView.js";

/** Dark to light. Space first, so the background stays genuinely empty. */
const RAMP = " .,:;i1tfLCG08@";

/** Default cell width in CSS pixels. Height is derived from the aspect below. */
const CELL_W = 9;

/**
 * Cell height as a multiple of cell width.
 *
 * A character cell is not square, and that is the whole reason `sample` below
 * cannot fit the image to the grid directly — see the note there.
 */
const CELL_ASPECT = 1.65;

/** Cursor influence radius, in CSS pixels. */
const CURSOR_R = 120;

/** Luminance above which a pixel counts as content when trimming. */
const TRIM_FLOOR = 0.08;

/** Longest edge the trim pass measures at. Full resolution buys nothing here. */
const TRIM_RES = 320;

/** A source-space rectangle: what `sample` should actually read from. */
interface Crop {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Bounding box of everything in `image` that reads as content.
 *
 * Measured on a downscaled copy — the box only has to be right to within a
 * character cell, and scanning a 1200x630 og-image at full size to find out
 * that most of it is white is a quarter of a million wasted iterations. The
 * result is returned in *source* pixels so the caller can pass it straight to
 * `drawImage`.
 *
 * Returns the whole image when nothing clears the floor, which is the honest
 * answer for a blank or undecodable bitmap and keeps `sample` branch-free.
 */
function contentBox(image: HTMLImageElement, invert: boolean): Crop {
  const whole: Crop = { x: 0, y: 0, w: image.width, h: image.height };

  const scale = Math.min(1, TRIM_RES / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));

  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d", { willReadFrequently: true });
  if (!octx) return whole;

  octx.drawImage(image, 0, 0, w, h);
  const { data } = octx.getImageData(0, 0, w, h);

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let i = 0; i < w * h; i += 1) {
    const p = i * 4;
    const alpha = (data[p + 3] as number) / 255;
    const raw =
      (0.299 * (data[p] as number) +
        0.587 * (data[p + 1] as number) +
        0.114 * (data[p + 2] as number)) /
      255;
    if ((invert ? 1 - raw : raw) * alpha < TRIM_FLOOR) continue;

    const x = i % w;
    const y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  if (maxX < 0) return whole;

  // Back to source pixels, with one measured pixel of bleed so a stroke that
  // ends exactly on the boundary is not shaved by the rounding.
  const inv = 1 / scale;
  const x = Math.max(0, (minX - 1) * inv);
  const y = Math.max(0, (minY - 1) * inv);
  return {
    x,
    y,
    w: Math.min(image.width - x, (maxX - minX + 3) * inv),
    h: Math.min(image.height - y, (maxY - minY + 3) * inv),
  };
}

export interface AsciiObjectProps {
  /** Source bitmap. Anything the browser can decode. */
  readonly src: string;
  /**
   * Treat *dark* pixels as the subject rather than bright ones.
   *
   * The ramp maps high luminance to dense glyphs, which is correct for a lit
   * subject on a dark ground — a photograph, a render. It is exactly backwards
   * for line art: a black wordmark on white would draw the white page in dense
   * characters and leave the mark itself blank. Set this for any flat mark on
   * a light ground.
   */
  readonly invert?: boolean | undefined;
  /**
   * Cell width in CSS pixels. Smaller means a finer grid and more glyphs to
   * draw each frame — worth spending on a wordmark, where legibility depends
   * on resolving stroke joins, and not worth it on a soft-edged photograph.
   */
  readonly cell?: number | undefined;
  /**
   * Crop the source to its content before sampling.
   *
   * Logo files are almost always delivered with generous margins baked in —
   * an og-image is mostly empty canvas. Contained into a square column that
   * leaves the mark small and floating. This measures the bounding box of
   * everything above `TRIM_FLOOR` once and samples only that, so the mark
   * fills the box regardless of how the file was exported.
   */
  readonly trim?: boolean | undefined;
  /** Omit when the page already describes the image in prose beside it. */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}

export function AsciiObject({
  src,
  invert = false,
  cell = CELL_W,
  trim = false,
  label,
  className,
}: AsciiObjectProps) {
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = host.current;
    const cv = surface.current;
    if (!wrap || !cv) return;

    const ctx = cv.getContext("2d", { alpha: true });
    if (!ctx) return;

    const still = prefersReducedMotion();

    /** Luminance grid, rebuilt only when the box or the image changes. */
    let grid: Float32Array | null = null;
    let cols = 0;
    let rows = 0;
    let width = 0;
    let height = 0;
    const cellW = cell;
    const cellH = cell * CELL_ASPECT;

    /** Beam origin in grid coordinates — the brightest cell found on sample. */
    let lampX = 0;
    let lampY = 0;

    let image: HTMLImageElement | null = null;
    /** Source rect to sample. Measured once on load, not on every resize. */
    let crop: Crop | null = null;
    let raf = 0;
    let visible = true;
    const pointer = { x: -9999, y: -9999, on: false };

    /* ---- sampling ------------------------------------------------------- */

    /**
     * Downsamples the bitmap to exactly one luminance value per character
     * cell. Done once per resize into a throwaway canvas: `drawImage` is
     * doing the box filter for us in native code, which is both faster and
     * better looking than averaging pixels in JS.
     */
    function sample(): void {
      if (!image || cols <= 0 || rows <= 0) return;

      const off = document.createElement("canvas");
      off.width = cols;
      off.height = rows;
      const octx = off.getContext("2d", { willReadFrequently: true });
      if (!octx) return;

      const box = crop ?? { x: 0, y: 0, w: image.width, h: image.height };

      /*
       * Contain the crop in the grid — in *cell space*, not pixel space.
       *
       * The grid is indexed in cells, but a cell is CELL_ASPECT times taller
       * than it is wide once drawn. Fitting the image to `cols x rows` as
       * though cells were square therefore does not preserve its proportions:
       * a mark laid out to N x M cells lands on screen at N*cellW by
       * M*cellH, so its rendered aspect comes out as the source aspect
       * *divided* by CELL_ASPECT. A 2.6:1 wordmark renders at 1.57:1 — 65%
       * too tall, which is exactly what it looks like.
       *
       * Pre-stretching the source width by CELL_ASPECT cancels that: the mark
       * claims more columns than rows in the grid, and the narrow cells
       * squeeze it back to its real proportions when drawn.
       */
      const fitW = box.w * CELL_ASPECT;
      const fitH = box.h;
      const scale = Math.min(cols / fitW, rows / fitH);
      const dw = fitW * scale;
      const dh = fitH * scale;
      octx.drawImage(
        image,
        box.x,
        box.y,
        box.w,
        box.h,
        (cols - dw) / 2,
        (rows - dh) / 2,
        dw,
        dh,
      );

      const { data } = octx.getImageData(0, 0, cols, rows);
      const next = new Float32Array(cols * rows);
      let best = -1;

      for (let i = 0; i < cols * rows; i += 1) {
        const p = i * 4;
        const alpha = (data[p + 3] as number) / 255;
        // Rec. 601 luma.
        const raw =
          (0.299 * (data[p] as number) +
            0.587 * (data[p + 1] as number) +
            0.114 * (data[p + 2] as number)) /
          255;
        /*
         * Alpha is applied *after* the inversion, not folded into the luma.
         * Folding it in would make a fully transparent cell read as black,
         * which inverts to fully bright — and the whole transparent margin
         * around a logo would light up as solid glyphs.
         */
        const lum = (invert ? 1 - raw : raw) * alpha;
        next[i] = lum;
        if (lum > best) {
          best = lum;
          lampX = i % cols;
          lampY = Math.floor(i / cols);
        }
      }

      grid = next;
    }

    /* ---- layout --------------------------------------------------------- */

    function resize(): void {
      const rect = wrap!.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;

      width = rect.width;
      height = rect.height;

      // Cap the device pixel ratio at 2. Past that the glyphs are smaller
      // than the eye resolves and the fill rate is spent for nothing.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv!.width = Math.round(width * dpr);
      cv!.height = Math.round(height * dpr);
      cv!.style.width = width + "px";
      cv!.style.height = height + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      cols = Math.max(1, Math.floor(width / cellW));
      rows = Math.max(1, Math.floor(height / cellH));

      sample();
    }

    /* ---- draw ----------------------------------------------------------- */

    function draw(now: number): void {
      if (!grid) return;

      ctx!.clearRect(0, 0, width, height);
      ctx!.font =
        '500 ' + Math.round(cellW * 1.5) + 'px "Geist Mono", ui-monospace, monospace';
      ctx!.textBaseline = "middle";
      ctx!.textAlign = "center";

      // One full sweep every 7.2s. Slow enough to read as a beam rather than
      // as a spinner. Parked out of range when motion is reduced.
      const beam = still ? -10 : ((now / 7200) % 1) * Math.PI * 2;

      const originX = (width - cols * cellW) / 2;
      const originY = (height - rows * cellH) / 2;

      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          const lum = grid[y * cols + x] as number;
          if (lum <= 0.02) continue;

          let px = originX + x * cellW + cellW / 2;
          let py = originY + y * cellH + cellH / 2;

          /* Beam: angular distance from the sweep line, measured at the lamp. */
          let lit = 0;
          if (!still) {
            const ang = Math.atan2(y - lampY, x - lampX);
            let d = Math.abs(((ang - beam + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
            d = Math.min(d, Math.PI * 2 - d);
            // A ~34 degree wedge, falling off to nothing at the edges.
            if (d < 0.6) lit = (1 - d / 0.6) ** 2;
          }

          /* Cursor: push away, and brighten. */
          if (pointer.on) {
            const dx = px - pointer.x;
            const dy = py - pointer.y;
            const dist = Math.hypot(dx, dy);
            if (dist < CURSOR_R && dist > 0.001) {
              const force = (1 - dist / CURSOR_R) ** 2;
              px += (dx / dist) * force * 26;
              py += (dy / dist) * force * 26;
              lit = Math.max(lit, force);
            }
          }

          const level = Math.min(1, lum + lit * 0.55);
          const glyph = RAMP[Math.min(RAMP.length - 1, Math.round(level * (RAMP.length - 1)))];
          if (!glyph || glyph === " ") continue;

          /*
           * Two colours only. Brand orange for anything the beam or the
           * cursor is currently lifting, bone white for the rest, with alpha
           * carrying the remaining tonal range. A per-cell gradient would
           * turn a legible object into mush at this glyph size.
           */
          ctx!.fillStyle =
            lit > 0.12
              ? "rgba(253, 85, 29, " + (0.35 + lit * 0.65).toFixed(3) + ")"
              : "rgba(238, 238, 238, " + (0.12 + lum * 0.62).toFixed(3) + ")";
          ctx!.fillText(glyph, px, py);
        }
      }
    }

    function loop(now: number): void {
      draw(now);
      raf = requestAnimationFrame(loop);
    }

    function start(): void {
      if (raf || still) return;
      raf = requestAnimationFrame(loop);
    }

    function stop(): void {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    }

    /* ---- wiring --------------------------------------------------------- */

    const img = new Image();
    img.decoding = "async";
    const onLoad = () => {
      image = img;
      crop = trim ? contentBox(img, invert) : null;
      resize();
      if (still || !visible) draw(0);
      else start();
    };
    img.addEventListener("load", onLoad, { once: true });
    img.src = src;
    if (img.complete && img.naturalWidth > 0) onLoad();

    const ro = new ResizeObserver(() => {
      resize();
      // A resize while the loop is parked still needs one frame, or the
      // canvas would sit empty until the reader scrolls back.
      if (!raf) draw(performance.now());
    });
    ro.observe(wrap);

    // Off screen the loop is cancelled rather than throttled. This canvas
    // sits in a hero that scrolls away and stays away.
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
      img.removeEventListener("load", onLoad);
    };
  }, [src, invert, cell, trim]);

  return (
    <div
      ref={host}
      className={className ? "fx-ascii " + className : "fx-ascii"}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    >
      <canvas ref={surface} />
    </div>
  );
}
