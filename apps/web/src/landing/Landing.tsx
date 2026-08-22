/**
 * Public landing page — everything before the wallet.
 *
 * Copy discipline matters more than layout here. This product's whole claim is
 * about bounds, so the page states the bound rather than the superlative: the
 * agent *reads* attacker text and *cannot* spend, the budget is confidential,
 * the payer is capped. Nothing on this page claims the AI is safe, because
 * that is not the claim the system supports. That rule survived the visual
 * rebuild unchanged, and the stats band is where it shows most — the three
 * numbers are 3, 7 and 0, because those are the true ones.
 *
 * ## Layout
 *
 * Editorial agency layout: a 12-column grid with a 1–2rem margin, sections
 * that alternate between ink (#141314) and bone (#eee), fluid display type
 * clamped between 375px and 1600px viewports, and mono for every label,
 * index and tag. Nothing has a shadow. The only radius on the page is on the
 * pill buttons.
 *
 * Motion is carried by five components in `./fx`, each one an idea borrowed
 * from Canvas UI and re-implemented against Canvas 2D or the DOM rather than
 * WebGL — the reasoning for that is in each file. The page owns none of it
 * beyond deciding where an effect earns its place.
 *
 * Presentational only. It renders no chain state, holds no key, and its single
 * outward action is asking the shell to connect a wallet.
 */

import { Flow } from "./Flow.js";
import { Process } from "./Process.js";
import { useSmoothScroll } from "./useSmoothScroll.js";
import type { ConnectPhase } from "../Root.js";
import { Accordion, type AccordionItem } from "./fx/Accordion.js";
import { AsciiObject } from "./fx/AsciiObject.js";
import { DecryptText } from "./fx/DecryptText.js";
import { GlyphRain } from "./fx/GlyphRain.js";
import { Marquee } from "./fx/Marquee.js";
import { Odometer } from "./fx/Odometer.js";
import { RippleField } from "./fx/RippleField.js";
import { SplitLines } from "./fx/SplitLines.js";
import { SplitText } from "./fx/SplitText.js";
import { useHeaderTone } from "./fx/useHeaderTone.js";
import {
  CapIcon,
  ClockIcon,
  LockIcon,
  ReplayIcon,
  SplitIcon,
  VerifyIcon,
} from "./icons.js";
import "./landing.css";

/*
 * In-page nav targets, as `[id, label]`.
 *
 * These render as buttons rather than `<a href="#id">`. A fragment link makes
 * the browser own the jump: it writes `#guarantees` into the address bar,
 * pushes a history entry, and — since the whole point of Lenis is that the
 * page is being scrolled by script — arrives instantly, undercutting the
 * smoothing everywhere it is used. A button hands the scroll to Lenis and
 * leaves the URL alone, which is what you want on camera and what you want in
 * a share link.
 *
 * The cost is real and accepted: these are no longer deep-linkable, and no
 * longer open in a new tab. The ids stay on the sections, so an external
 * `/#security` still works; only the in-page controls change.
 */
const NAV_LINKS: ReadonlyArray<readonly [id: string, label: string]> = [
  ["process", "Process"],
  ["flow", "Path"],
  ["guarantees", "Guarantees"],
  ["questions", "Questions"],
];

/**
 * The stack, as bare wordmarks. No logo files, so the type is the mark.
 *
 * AIsa was absent, which was simply wrong: it runs the inference the agent
 * thinks with *and* sells the search the agent buys. Two load-bearing roles and
 * no mention anywhere on this page.
 */
const STACK = ["INCO", "AISA", "BASE", "X402", "EIP-3009", "METAMASK", "VIEM"];

/**
 * The three numbers, and only numbers the system can defend. "3" is the
 * signature count, "9" is the stage count, "0" is the number of keys the model
 * is ever handed. A fourth stat would have had to be invented.
 *
 * The stage count read 07 while `STAGE_IDS` in the dashboard held nine and the
 * catalog copy promised a "nine-stage path". The seven belongs to the diagram
 * below — seven *components* — and using one word for both counts is what let
 * the page contradict the product it links to.
 */
const STATS: ReadonlyArray<{
  readonly value: string;
  readonly suffix?: string;
  readonly label: string;
}> = [
  { value: "03", label: "Wallet signatures per run" },
  { value: "09", label: "Stages in the payment path" },
  { value: "00", label: "Keys the model ever holds" },
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
] as const;

const QUESTIONS: readonly AccordionItem[] = [
  {
    q: "What stops the agent from spending more than I allowed?",
    a: "It never holds spending authority. The budget is enforced by a confidential policy evaluated inside a TEE, and the payer key is derived in an enclave that only signs against a finalized on-chain record. Convincing the model achieves nothing, because the model is not the thing being asked.",
  },
  {
    q: "Can prompt injection reach the payment?",
    a: "It can reach the agent, which is the point of the design. The agent reads vendor text and can be fully persuaded by it — and still cannot move funds, because the component holding the payer key never reads that text and never takes instructions from it.",
  },
  {
    q: "If the budget is encrypted, how is it enforced?",
    a: "Inco evaluates the comparison confidentially and commits the debit before the answer is knowable. You cannot branch on a secret, so the debit is unconditional and the outcome is what gets revealed — not the balance.",
  },
  {
    q: "What happens if a settlement is interrupted halfway?",
    a: "Nonces are deterministic, so the retry produces the identical authorization rather than a second one. An interrupted run resumes; it does not double-pay.",
  },
  {
    q: "Which chain and which token?",
    a: "Base Sepolia, settled in USDC over x402 using EIP-3009 transfer authorizations. Settlement is gasless for the payer and single-use per authorization.",
  },
  {
    q: "Can I verify a run without trusting this interface?",
    a: "Yes. Every decision is attested on chain and matched against the handle the contract stored, not one the caller supplied. An RPC endpoint and a block explorer are enough to check the whole run independently.",
  },
];

export function Landing({
  onConnect,
  phase = "idle",
}: {
  onConnect: () => void;
  /** Reported by the shell so the CTA can show what the wallet is doing. */
  phase?: ConnectPhase;
}) {
  const connecting = phase === "connecting";
  // The header floats over sections that alternate ink and bone, so it has to
  // recolour itself as they pass underneath.
  const tone = useHeaderTone();
  // Smooths the wheel for as long as this page is mounted, and gives the
  // in-page controls something to scroll with.
  const scrollToId = useSmoothScroll();

  return (
    <div className="gf">
      {/* ---------------------------------------------------------- header */}
      <header className="gf-header" data-tone={tone}>
        <div className="gf-container gf-header-in">
          <button type="button" className="gf-brand" onClick={() => scrollToId("top")}>
            LedgerLighthouse
          </button>

          <nav className="gf-nav" aria-label="Sections">
            {NAV_LINKS.map(([id, label]) => (
              <button key={id} type="button" className="gf-nav-link" onClick={() => scrollToId(id)}>
                {label}
              </button>
            ))}
          </nav>

          <button type="button" className="gf-pill gf-pill-sm" onClick={onConnect}>
            Launch console
          </button>
        </div>
      </header>

      {/* ------------------------------------------------------------ hero */}
      <section className="gf-sec gf-ink gf-hero" id="top">
        <div className="gf-container gf-hero-in">
          <div className="gf-grid gf-hero-grid">
            <div className="gf-hero-copy">
              <SplitLines
                as="h1"
                className="gf-display"
                lines={["Pay APIs. ", "Don't trust ", "the AI."]}
                delay={120}
                stagger={110}
              />

              <SplitText
                className="gf-hero-sub"
                text="Encrypted budgets, prompt-injection-resistant authorization, and independently capped execution on Base Sepolia."
                delay={520}
              />

              <div className="gf-hero-actions">
                <button
                  type="button"
                  className="gf-pill"
                  onClick={onConnect}
                  disabled={connecting}
                  data-busy={connecting ? "" : undefined}
                >
                  {connecting ? "Waiting for MetaMask" : "Connect with MetaMask"}
                </button>
                {/* Same reasoning as the nav: a button, so the hero CTA glides
                    into the path section instead of teleporting. */}
                <button type="button" className="gf-text-link" onClick={() => scrollToId("flow")}>
                  See the path
                </button>
              </div>

              {/* Only ever rendered after a real refusal, so it cannot read as
                  a warning to someone who has not tried yet. */}
              {phase === "declined" ? (
                <p className="gf-note" role="status">
                  Connection declined — nothing was sent. Try again when ready.
                </p>
              ) : null}
            </div>

            <div className="gf-hero-object">
              {/*
                The x402 wordmark, resolved to characters.

                `invert` because the mark is black art on nothing — without it
                the ramp would draw the empty ground and leave the letterforms
                blank. `cell` is finer than the default: a wordmark is judged
                on whether the stroke joins resolve, and at 9px they do not.
                `trim` costs one downscaled scan on load and makes the mark
                fill its box whatever margins the source file was exported
                with.

                Decorative, and labelled nowhere: "x402" already appears in
                the stack row directly below this, in text.
              */}
              <AsciiObject src="/x402.svg" invert cell={6} trim />
            </div>
          </div>

          <div className="gf-hero-stack">
            <span className="gf-mono gf-dim">Built on</span>
            <span className="gf-stack-marks">
              {STACK.slice(0, 4).map((mark) => (
                <span className="gf-mark" key={mark}>
                  {mark}
                </span>
              ))}
              <span className="gf-mono gf-dim">+ many more</span>
            </span>
          </div>
        </div>

        <div className="gf-hero-rule" aria-hidden="true" />
      </section>

      {/* ----------------------------------------------------------- stats */}
      <section className="gf-sec gf-bone gf-stats" aria-label="By the numbers">
        <div className="gf-container">
          <div className="gf-grid gf-stats-grid">
            {STATS.map((stat) => (
              <div className="gf-stat" key={stat.label}>
                <Odometer className="gf-stat-n" value={stat.value} suffix={stat.suffix} />
                <span className="gf-stat-label gf-mono">{stat.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- process */}
      <section className="gf-sec gf-bone" id="process">
        <div className="gf-container">
          <div className="gf-grid gf-head">
            <SplitLines as="h2" className="gf-h2 gf-head-title" lines={["How it works."]} />
            <p className="gf-mono gf-dim gf-head-tag">
              <DecryptText text="// PROCESS" />
            </p>
          </div>

          <Process />
        </div>
      </section>

      {/* ------------------------------------------------------------ path */}
      <section className="gf-sec gf-ink" id="flow">
        <div className="gf-container">
          <div className="gf-grid gf-head">
            <SplitLines as="h2" className="gf-h2 gf-head-title" lines={["The payment path."]} />
            <p className="gf-mono gf-dim gf-head-tag">
              <DecryptText text="// SEVEN COMPONENTS" />
            </p>
          </div>
          <p className="gf-lede">
            Seven components, one of which can be compromised safely. Hover any of them for the
            line that makes it matter.
          </p>
          <Flow />
        </div>
      </section>

      {/* ------------------------------------------------------ guarantees */}
      <section className="gf-sec gf-bone" id="guarantees">
        <div className="gf-container">
          <div className="gf-grid gf-head">
            <SplitLines
              as="h2"
              className="gf-h2 gf-head-title"
              lines={["What's in a ", "bound."]}
            />
            <p className="gf-mono gf-dim gf-head-tag">
              <DecryptText text="// THE GUARANTEES" />
            </p>
          </div>

          <p className="gf-rule-label gf-mono">Bounds, not promises.</p>

          <ul className="gf-bounds">
            {FEATURES.map(({ Icon, title, body }) => (
              <li className="gf-bound" key={title}>
                <span className="gf-bound-icon" aria-hidden="true">
                  <Icon />
                </span>
                <h3 className="gf-bound-title">
                  <DecryptText text={title.toUpperCase()} />
                </h3>
                <p className="gf-bound-body">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ------------------------------------------------------- questions */}
      <section className="gf-sec gf-ink gf-questions" id="questions">
        {/* Sits behind the section at low alpha. The copy on top keeps full
            contrast because the canvas never paints over it. */}
        <GlyphRain />
        <div className="gf-container gf-questions-in">
          <div className="gf-grid gf-head">
            <SplitLines as="h2" className="gf-h2 gf-head-title" lines={["Common ", "questions"]} />
            <p className="gf-mono gf-dim gf-head-tag">
              <DecryptText text="// FAQ" />
            </p>
          </div>
          <Accordion items={QUESTIONS} />
        </div>
      </section>

      {/* ------------------------------------------------------------- cta */}
      <RippleField className="gf-sec gf-bone gf-cta">
        <div className="gf-container">
          <div className="gf-grid gf-cta-grid">
            <SplitLines as="h2" className="gf-display gf-cta-title" lines={["Start a ", "run."]} />
            <div className="gf-cta-side">
              <p className="gf-cta-lede">
                Connect a wallet, or read the source. Every claim on this page is checkable without
                trusting this interface.
              </p>
              <div className="gf-hero-actions">
                <button type="button" className="gf-pill" onClick={onConnect} disabled={connecting}>
                  {connecting ? "Waiting for MetaMask" : "Connect with MetaMask"}
                </button>
                <a
                  className="gf-text-link"
                  href="https://github.com/adarshkr7/LedgerLighthouse"
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the source
                </a>
              </div>
            </div>
          </div>
        </div>
      </RippleField>

      {/* ---------------------------------------------------------- footer */}
      <footer className="gf-sec gf-ink gf-footer">
        <div className="gf-container gf-footer-in">
          <Marquee
            className="gf-footer-marquee"
            items={STACK.map((mark) => (
              <span className="gf-mark">{mark}</span>
            ))}
          />

          <div className="gf-grid gf-footer-grid">
            <SplitLines
              as="p"
              className="gf-display gf-footer-statement"
              lines={["The authority ", "never reaches ", "the model."]}
            />

            <nav className="gf-footer-links" aria-label="Resources">
              <a href="https://github.com/adarshkr7/LedgerLighthouse" target="_blank" rel="noreferrer">
                GitHub
              </a>
              <a
                href="https://github.com/adarshkr7/LedgerLighthouse/blob/main/README.md"
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
          </div>

          <div className="gf-footer-base gf-mono gf-dim">
            <span>Built with Inco and AIsa</span>
            <span>Base Sepolia</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
