/**
 * Public landing page — everything before the wallet.
 *
 * Copy discipline matters more than layout here. This product's whole claim is
 * about bounds, so the page states the bound rather than the superlative: the
 * agent *reads* attacker text and *cannot* spend, the budget is confidential,
 * the payer is capped. Nothing on this page claims the AI is safe, because that
 * is not the claim the system supports.
 *
 * Presentational only. It renders no chain state, holds no key, and its single
 * outward action is asking the shell to connect a wallet.
 */

import { useEffect, useRef } from "react";

import { Flow } from "./Flow.js";
import type { ConnectPhase } from "../Root.js";
import {
  CapIcon,
  ClockIcon,
  LockIcon,
  ReplayIcon,
  SplitIcon,
  VerifyIcon,
} from "./icons.js";
import "./landing.css";

const TRUST = [
  "Inco confidential compute",
  "Base Sepolia",
  "EIP-3009",
  "x402",
  "End-to-end verifiable",
];

const FEATURES = [
  {
    Icon: LockIcon,
    title: "Encrypted budgets",
    body: "The spending limit is encrypted in your browser. On chain it is an opaque handle.",
  },
  {
    Icon: SplitIcon,
    title: "Prompt-injection isolation",
    body: "The component that reads vendor text has no spending authority. The two never meet.",
  },
  {
    Icon: ReplayIcon,
    title: "Replay protection",
    body: "Deterministic nonces let an interrupted settlement retry without ever paying twice.",
  },
  {
    Icon: ClockIcon,
    title: "Frozen authorization windows",
    body: "Validity is fixed when the spend is requested, never regenerated from the clock.",
  },
  {
    Icon: CapIcon,
    title: "Ephemeral spending caps",
    body: "Each goal gets its own throwaway payer holding only what you chose to fund.",
  },
  {
    Icon: VerifyIcon,
    title: "On-chain verification",
    body: "Every decision is attested, handle-matched, and checkable by anyone with an RPC.",
  },
];

const TYPICAL = [
  "AI holds spending authority",
  "Public budgets",
  "Prompt can influence payment",
  "Single point of failure",
];

const OURS = [
  "AI never controls the wallet",
  "Budget stays confidential",
  "Authorization ignores attacker text",
  "Multiple independent safety bounds",
];

const METRICS = [
  ["Budget", "0.20"],
  ["Agent", "Structured only"],
  ["Policy", "Confidential"],
  ["Settlement", "Confirmed"],
];

const TIMELINE = ["requestSpend committed", "Confidential evaluation", "Payment settled"];

export function Landing({
  onConnect,
  phase = "idle",
}: {
  onConnect: () => void;
  /** Reported by the shell so the CTA can show what the wallet is doing. */
  phase?: ConnectPhase;
}) {
  const root = useRef<HTMLDivElement>(null);
  const connecting = phase === "connecting";

  /*
   * Scroll reveal.
   *
   * The `js-reveal` class is added *by this effect*, so the hidden initial
   * state only ever exists when there is something running that can undo it.
   * Setting it in the stylesheet instead would leave the whole page blank if
   * the script failed to load.
   *
   * Sections are unobserved once seen — this is an entrance, not a scrubber,
   * and re-animating on scroll-back is the thing that makes reveals annoying.
   */
  useEffect(() => {
    const el = root.current;
    if (!el) return;

    const targets = el.querySelectorAll<HTMLElement>(".lp-reveal");
    if (!("IntersectionObserver" in window)) return;

    el.classList.add("js-reveal");

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-seen", "");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.06 },
    );

    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing" ref={root}>
      {/* 0 — NAV */}
      <nav className="lp-nav">
        <div className="lp-nav-inner">
          <span className="lp-nav-brand">
            <span className="lp-nav-name">LedgerLighthouse</span>
          </span>
          <span className="lp-nav-links">
            <a href="#flow">Flow</a>
            <a href="#guarantees">Guarantees</a>
            <a href="#security">Security</a>
          </span>
          <button type="button" className="lp-btn lp-btn-ghost" onClick={onConnect}>
            Launch console
          </button>
        </div>
      </nav>

      {/* 1 — HERO */}
      <header className="lp-hero">
        {/* Decorative: the page states everything this image states, in words,
            immediately beside it. */}
        <div className="lp-hero-bg" aria-hidden="true" />
        <div className="lp-hero-scrim" aria-hidden="true" />

        <div className="lp-hero-copy">
          <p className="lp-eyebrow lp-in" style={{ animationDelay: "60ms" }}>
            <span className="lp-num">00</span>
            Confidential Agentic Payments
          </p>
          <h1 className="lp-headline lp-in" style={{ animationDelay: "140ms" }}>
            Pay APIs.
            <br />
            Don&apos;t <em>trust the AI.</em>
          </h1>
          <p className="lp-sub lp-in" style={{ animationDelay: "240ms" }}>
            Encrypted budgets, prompt-injection-resistant authorization, and independently capped
            execution on Base Sepolia.
          </p>
          <div className="lp-actions lp-in" style={{ animationDelay: "340ms" }}>
            <button
              type="button"
              className="lp-btn"
              onClick={onConnect}
              disabled={connecting}
              data-connecting={connecting ? "true" : undefined}
            >
              {connecting ? "Waiting for MetaMask" : "Connect with MetaMask"}
            </button>
            <a className="lp-btn lp-btn-ghost" href="#flow">
              See the flow
            </a>
          </div>
          {/* Only ever rendered after a real refusal, so it cannot read as a
              warning to someone who has not tried yet. */}
          {phase === "declined" ? (
            <p className="lp-connect-note" role="status">
              Connection declined — nothing was sent. Try again when ready.
            </p>
          ) : null}
        </div>
      </header>

      {/* 2 — WORKFLOW */}
      <section className="lp-section lp-reveal" id="flow">
        <p className="lp-eyebrow">
          <span className="lp-num">01</span>
          The path of a single payment
        </p>
        <h2 className="lp-h2">Seven steps, one of which can be compromised safely.</h2>
        <Flow />
      </section>

      {/* 3 — TRUST STRIP */}
      <section className="lp-trust lp-reveal" aria-label="Built on">
        {TRUST.map((item) => (
          <span key={item} className="lp-trust-item">
            {item}
          </span>
        ))}
      </section>

      {/* 4 — FEATURES */}
      <section className="lp-section lp-reveal sw-dots" id="guarantees">
        <p className="lp-eyebrow">
          <span className="lp-num">02</span>
          What the system guarantees
        </p>
        <h2 className="lp-h2">Bounds, not promises.</h2>
        <div className="lp-grid">
          {FEATURES.map(({ Icon, title, body }) => (
            <article key={title} className="lp-card">
              <span className="lp-card-icon">
                <Icon />
              </span>
              <h3 className="lp-card-title">{title}</h3>
              <p className="lp-card-body">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* 5 — COMPARISON */}
      <section className="lp-section lp-reveal">
        <p className="lp-eyebrow">
          <span className="lp-num">03</span>
          Why this is different
        </p>
        <h2 className="lp-h2">The authority never reaches the model.</h2>
        <div className="lp-compare">
          <div className="lp-col">
            <h3 className="lp-col-title">Typical AI wallet</h3>
            <ul className="lp-list">
              {TYPICAL.map((item) => (
                <li key={item} className="lp-list-item">
                  <span className="lp-mark" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="lp-col lp-col-emphasis">
            <h3 className="lp-col-title">This system</h3>
            <ul className="lp-list">
              {OURS.map((item) => (
                <li key={item} className="lp-list-item">
                  <span className="lp-mark lp-mark-on" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* 6 — EXECUTION PREVIEW */}
      <section className="lp-section lp-reveal">
        <p className="lp-eyebrow">
          <span className="lp-num">04</span>
          Live execution
        </p>
        <h2 className="lp-h2">What the console shows while it runs.</h2>
        {/* Static illustration of the console. Not interactive, and labelled as
            a preview so it is never mistaken for live state. */}
        <div className="lp-preview" role="img" aria-label="Preview of the execution console after a completed honest request">
          <div className="lp-preview-head">
            <span className="lp-status">Success</span>
            <span className="lp-preview-title">Honest request completed</span>
            <span className="lp-preview-sub">0.01 USDC settled on Base Sepolia</span>
          </div>
          <dl className="lp-metrics">
            {METRICS.map(([label, value]) => (
              <div key={label} className="lp-metric">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <ol className="lp-timeline">
            {TIMELINE.map((item) => (
              <li key={item} className="lp-timeline-item">
                {item}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 7 — SECURITY */}
      <section className="lp-section lp-reveal sw-diagonal" id="security">
        <p className="lp-eyebrow">
          <span className="lp-num">05</span>
          Security model
        </p>
        <h2 className="lp-h2">Bounded autonomous execution</h2>
        <div className="lp-prose">
          <p>The browser encrypts the budget before it ever reaches the chain.</p>
          <p>The policy is evaluated confidentially, and the debit commits before the answer is knowable.</p>
          <p>Payments are signed only from finalized on-chain records, never from caller input.</p>
        </div>
      </section>

      {/* 8 — FINAL CTA */}
      <section className="lp-cta lp-reveal">
        <p className="lp-eyebrow">
          <span className="lp-num">06</span>
          Get started
        </p>
        <h2 className="lp-cta-title">
          Let agents pay APIs.
          <br />
          Keep the authority <em>cryptographically bounded.</em>
        </h2>
        <button type="button" className="lp-btn" onClick={onConnect}>
          Connect with MetaMask
        </button>
        <p className="lp-cta-note">No backend changes required to preview the flow.</p>
      </section>

      {/* 9 — FOOTER */}
      <footer className="lp-footer">
        <nav className="lp-footer-links" aria-label="Resources">
          <a href="https://github.com/adarshkr7/NTU_x402" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a
            href="https://github.com/adarshkr7/NTU_x402/blob/main/README.md"
            target="_blank"
            rel="noreferrer"
          >
            Docs
          </a>
          <a
            href="https://sepolia.basescan.org/address/0x0C759D06a1c14F43852D7b078Db2f8C342F15921"
            target="_blank"
            rel="noreferrer"
          >
            BaseScan
          </a>
        </nav>
        <p className="lp-footer-note">Built with Inco</p>
      </footer>
    </div>
  );
}
