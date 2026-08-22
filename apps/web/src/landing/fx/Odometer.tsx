/**
 * Counting stat — a column of 0-9 per digit place, rolled to the target.
 *
 * The reference site builds its numbers this way rather than by tweening a
 * text node, and the difference is visible: a tweened number reflows its own
 * width on every frame as glyphs change, so the label beside it twitches. A
 * reel is laid out once at the settled width and only ever transforms, which
 * costs nothing on the compositor and holds the baseline perfectly still.
 *
 * Places roll with a per-place delay increasing left to right, so the number
 * settles the way a mechanical counter does — high places first, ones last.
 */

import { useInView } from "./useInView.js";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export interface OdometerProps {
  /** Digits to land on, as a string so leading zeros survive. */
  readonly value: string;
  /*
   * `| undefined` is explicit on all three because the project compiles with
   * `exactOptionalPropertyTypes`, under which `prefix?: string` refuses a
   * `prefix={maybeUndefined}` that a caller reads straight off its data. The
   * alternative is a conditional spread at every call site, which is worse.
   */
  /** Rendered before the reel — a currency mark, typically. */
  readonly prefix?: string | undefined;
  /** Rendered after the reel — a unit or magnitude suffix. */
  readonly suffix?: string | undefined;
  readonly className?: string | undefined;
}

export function Odometer({ value, prefix, suffix, className }: OdometerProps) {
  const [ref, seen] = useInView<HTMLSpanElement>({ threshold: 0.5 });
  const places = value.split("");

  return (
    <span ref={ref} className={className} data-seen={seen ? "" : undefined} aria-label={`${prefix ?? ""}${value}${suffix ?? ""}`}>
      {prefix ? (
        <span className="fx-odo-fix" aria-hidden="true">
          {prefix}
        </span>
      ) : null}

      <span className="fx-odo-reels" aria-hidden="true">
        {places.map((digit, i) => {
          const target = Number.parseInt(digit, 10);
          // A non-digit place (a separator, say) is printed flat — there is
          // nothing to roll.
          if (Number.isNaN(target)) {
            return (
              <span className="fx-odo-fix" key={i}>
                {digit}
              </span>
            );
          }
          return (
            <span className="fx-odo-place" key={i}>
              <span
                className="fx-odo-strip"
                style={{
                  transform: seen ? `translateY(${-target * 10}%)` : "translateY(0%)",
                  transitionDelay: `${i * 70}ms`,
                }}
              >
                {DIGITS.map((d) => (
                  <span className="fx-odo-digit" key={d}>
                    {d}
                  </span>
                ))}
              </span>
            </span>
          );
        })}
      </span>

      {suffix ? (
        <span className="fx-odo-fix" aria-hidden="true">
          {suffix}
        </span>
      ) : null}
    </span>
  );
}
