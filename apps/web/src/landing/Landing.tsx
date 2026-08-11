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

import { BlockStream } from "./BlockStream.js";
import { Flow } from "./Flow.js";
import { TotemHero, TotemMark } from "../brand/Totem.js";
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

export function Landing({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="landing">
      {/* 0 — NAV */}
      <nav className="lp-nav">
        <span className="lp-nav-brand">
          <TotemMark size={19} />
          <span className="lp-nav-name">Totem</span>
        </span>
        <span className="lp-nav-links">
          <a href="#flow">Flow</a>
          <a href="#guarantees">Guarantees</a>
          <a href="#security">Security</a>
        </span>
        <button type="button" className="lp-btn lp-btn-ghost" onClick={onConnect}>
          Launch console
        </button>
      </nav>

      {/* 1 — HERO */}
      <header className="lp-hero">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow">Confidential Agentic Payments</p>
          <h1 className="lp-headline">
            Autonomous AI payments
            <br />
            without giving the AI your wallet.
          </h1>
          <p className="lp-sub">
            Encrypted budgets, prompt-injection-resistant authorization, and independently capped
            execution on Base Sepolia.
          </p>
          <div className="lp-actions">
            <button type="button" className="lp-btn" onClick={onConnect}>
              Connect with MetaMask
            </button>
            <a className="lp-btn lp-btn-ghost" href="#flow">
              See the flow
            </a>
          </div>
        </div>
        <div className="lp-hero-visual">
          <TotemHero />
          <BlockStream />
        </div>
      </header>

      {/* 2 — WORKFLOW */}
      <section className="lp-section" id="flow">
        <p className="lp-eyebrow">The path of a single payment</p>
        <h2 className="lp-h2">Seven steps, one of which can be compromised safely.</h2>
        <Flow />
      </section>

      {/* 3 — TRUST STRIP */}
      <section className="lp-trust" aria-label="Built on">
        {TRUST.map((item) => (
          <span key={item} className="lp-trust-item">
            {item}
          </span>
        ))}
      </section>

      {/* 4 — FEATURES */}
      <section className="lp-section" id="guarantees">
        <p className="lp-eyebrow">What the system guarantees</p>
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
      <section className="lp-section">
        <p className="lp-eyebrow">Why this is different</p>
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
      <section className="lp-section">
        <p className="lp-eyebrow">Live execution</p>
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
      <section className="lp-section" id="security">
        <p className="lp-eyebrow">Security model</p>
        <h2 className="lp-h2">Bounded autonomous execution</h2>
        <div className="lp-prose">
          <p>The browser encrypts the budget before it ever reaches the chain.</p>
          <p>The policy is evaluated confidentially, and the debit commits before the answer is knowable.</p>
          <p>Payments are signed only from finalized on-chain records, never from caller input.</p>
        </div>
      </section>

      {/* 8 — FINAL CTA */}
      <section className="lp-cta">
        <h2 className="lp-cta-title">
          Let agents pay APIs.
          <br />
          Keep the authority cryptographically bounded.
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
        <p className="lp-footer-note">
          <TotemMark size={13} />
          Built with Inco
        </p>
      </footer>
    </div>
  );
}
