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

/**
 * Copy-to-clipboard with an inline confirmation.
 *
 * A hash you cannot copy is decoration, and a `title` tooltip is not reachable
 * by keyboard. So this is a real button, and its icon turns to a check when
 * the copy lands.
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
        data-copied={copied ? "" : undefined}
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy ${value}`}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </span>
  );
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
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
  size = 110,
}: {
  spent: bigint;
  funded: bigint;
  caption: string;
  /** Rendered diameter in px. The drawing scales with it, stroke included. */
  size?: number;
}) {
  const pct = funded === 0n ? 0 : Number((spent * 10_000n) / funded) / 100;
  const clamped = Math.max(0, Math.min(100, pct));
  const r = 46;
  const circumference = 2 * Math.PI * r;
  const remaining = funded > spent ? funded - spent : 0n;

  return (
    <div className="d-ring">
      <svg viewBox="0 0 110 110" width={size} height={size} role="img" aria-label={caption}>
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
