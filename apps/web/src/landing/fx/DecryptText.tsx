/**
 * Decrypt Reveal — text arrives as cipher and resolves into the real string.
 *
 * The idea is Canvas UI's "Decrypt Reveal", which renders live HTML as ASCII
 * cipher text and decrypts it around the cursor. That component is a WebGL
 * pass over a rasterised DOM; this is the same *effect* done in the DOM
 * itself, because the thing that needs decrypting here is a line of text, not
 * a page, and a shader is a large amount of machinery to point at a heading.
 *
 * On this product the effect is not decoration. Every label it wraps names a
 * value that really is encrypted somewhere in the system — the budget, the
 * policy, the handle — so the heading behaves like the thing it describes.
 * That is also why it is applied to short mono labels only and never to body
 * copy: scrambling a paragraph would make the page unreadable for the several
 * hundred milliseconds it takes to settle, which is a real accessibility cost
 * for no additional meaning.
 *
 * Accessibility: the element carries the settled text as `aria-label` and the
 * scrambling span is `aria-hidden`, so a screen reader is handed the final
 * string immediately and never reads cipher noise. Reduced motion skips
 * straight to the settled state.
 */

import { useEffect, useRef, useState, type ElementType } from "react";

import { prefersReducedMotion, useInView } from "./useInView.js";

/** Glyphs the scramble draws from — deliberately mono-friendly and neutral. */
const CIPHER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/\<>[]{}#$%&*+=@";

/** Milliseconds between scramble frames. ~24fps reads as machine, not jitter. */
const FRAME_MS = 42;

/** Frames each character spends scrambling before it locks. */
const HOLD_FRAMES = 3;

export interface DecryptTextProps {
  /** The settled string. Whitespace is never scrambled, so words keep shape. */
  readonly text: string;
  /** Element to render. Defaults to a span so it can sit inline. */
  readonly as?: ElementType;
  readonly className?: string;
  /** Delay after the element enters view, in ms. */
  readonly delay?: number;
}

export function DecryptText({ text, as: Tag = "span", className, delay = 0 }: DecryptTextProps) {
  const [ref, seen] = useInView<HTMLSpanElement>({ threshold: 0.4 });
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? text : ""));
  const frame = useRef(0);

  useEffect(() => {
    if (!seen) return;
    if (prefersReducedMotion()) {
      setShown(text);
      return;
    }

    /*
     * The reveal is a moving frontier, not a global fade. `locked` walks left
     * to right one character every HOLD_FRAMES; everything ahead of it is
     * redrawn from CIPHER each frame. That reads as decryption. Randomising
     * every character independently reads as static.
     */
    let timer = 0;
    let interval = 0;
    frame.current = 0;

    const tick = () => {
      const locked = Math.floor(frame.current / HOLD_FRAMES);
      if (locked >= text.length) {
        setShown(text);
        window.clearInterval(interval);
        return;
      }

      let out = "";
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i] as string;
        if (i < locked || ch === " ") out += ch;
        else out += CIPHER[Math.floor(Math.random() * CIPHER.length)];
      }
      setShown(out);
      frame.current += 1;
    };

    timer = window.setTimeout(() => {
      tick();
      interval = window.setInterval(tick, FRAME_MS);
    }, delay);

    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [seen, text, delay]);

  return (
    <Tag ref={ref} className={className} aria-label={text}>
      {/* Reserves the settled width so nothing around this reflows mid-scramble. */}
      <span className="fx-decrypt-ghost" aria-hidden="true">
        {text}
      </span>
      <span className="fx-decrypt-live" aria-hidden="true">
        {shown}
      </span>
    </Tag>
  );
}
