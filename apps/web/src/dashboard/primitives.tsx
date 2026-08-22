/**
 * Small presentational pieces for the dashboard. No chain reads, no protocol
 * knowledge — every one of these takes already-derived values as props.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { explorer } from "../lib/config.js";

/** Label above value. Captions carry the meaning; prose is kept out of the UI. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="d-field">
      <span className="d-label">{label}</span>
      <span className="d-value">{children}</span>
    </div>
  );
}

export function Dot({ tone = "live" }: { tone?: "live" | "idle" }) {
  return <span className="d-dot" data-tone={tone} aria-hidden="true" />;
}

/**
 * Copy-to-clipboard with an inline confirmation.
 *
 * A hash you cannot copy is decoration, and a `title` tooltip is not reachable
 * by keyboard — so this is a real button with a visible label change.
 */
export function Copyable({
  value,
  display,
  href,
  mono = true,
}: {
  value: string;
  display?: string;
  href?: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [value]);

  return (
    <span className="d-copyable">
      {href ? (
        <a className={mono ? "d-mono" : undefined} href={href} target="_blank" rel="noreferrer">
          {display ?? value}
        </a>
      ) : (
        <span className={mono ? "d-mono" : undefined}>{display ?? value}</span>
      )}
      <button
        type="button"
        className="d-copy-btn"
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy ${value}`}
      >
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}

export function TxLink({ label, hash }: { label: string; hash?: string | undefined }) {
  if (!hash) {
    return (
      <div className="d-field">
        <span className="d-label">{label}</span>
        <span className="d-value d-muted">—</span>
      </div>
    );
  }
  return (
    <div className="d-field">
      <span className="d-label">{label}</span>
      <span className="d-value">
        <Copyable value={hash} display={truncate(hash)} href={explorer.tx(hash)} />
      </span>
    </div>
  );
}

export function truncate(hex: string, lead = 10, tail = 8): string {
  return hex.length <= lead + tail + 1 ? hex : `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

/**
 * Progress ring over the **ephemeral payer's** funded amount.
 *
 * Deliberately not the encrypted budget. That value is confidential by design —
 * nobody, including this UI, can read it — so a ring claiming to show "budget
 * remaining" would be inventing a number and quietly contradicting the product's
 * central claim. What is public, and genuinely bounds the loss, is how much of
 * the funded payer balance has been spent. That is what this shows, and the
 * label says so.
 */
export function Ring({
  spent,
  funded,
  caption,
}: {
  spent: bigint;
  funded: bigint;
  caption: string;
}) {
  const pct = funded === 0n ? 0 : Number((spent * 10_000n) / funded) / 100;
  const clamped = Math.max(0, Math.min(100, pct));
  const r = 46;
  const circumference = 2 * Math.PI * r;
  const remaining = funded > spent ? funded - spent : 0n;

  return (
    <div className="d-ring">
      <svg viewBox="0 0 110 110" width="110" height="110" role="img" aria-label={caption}>
        <circle cx="55" cy="55" r={r} className="d-ring-track" />
        <circle
          cx="55"
          cy="55"
          r={r}
          className="d-ring-value"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
        />
      </svg>
      <div className="d-ring-centre">
        <span className="d-ring-figure">{formatUnits(remaining)}</span>
        <span className="d-ring-unit">USDC left</span>
      </div>
    </div>
  );
}

function formatUnits(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${frac}`;
}
