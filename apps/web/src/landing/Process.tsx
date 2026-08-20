/**
 * "How it works" — an interactive step list wired to a gallery.
 *
 * Four steps on the left, one frame on the right. Pointing at, focusing or
 * tapping a step brings its screenshot up in the frame; every other step dims.
 *
 * ## Why the bodies stay open
 *
 * The obvious version of this collapses each step's paragraph and expands only
 * the active one. It was rejected: the gallery beside the list is a fixed
 * height, so a list that changes height on *hover* makes the two columns
 * disagree about where the section ends, and the page shifts under a pointer
 * that was only passing through. Dimming carries the same signal — which step
 * the frame is showing — and costs no layout.
 *
 * ## Why these are screenshots and not diagrams
 *
 * Each frame is the real console in the state that step describes, including
 * the two refusals. A drawn diagram of a policy refusing a payment is an
 * assertion; a screenshot of the refusal is closer to evidence, which is the
 * register this whole page is trying to stay in.
 *
 * ## Not a tablist
 *
 * `role="tab"` would be wrong here. Tabs mean the panel holds the content and
 * the tab is just its handle — but every word of content is in the list
 * itself, permanently, and the frame is illustration. So these are plain
 * buttons that own an image, described by `aria-controls`, and the list reads
 * completely with the frame ignored.
 */

import { useId, useState } from "react";

interface Step {
  readonly title: string;
  readonly body: string;
  readonly src: string;
  /** Describes the screenshot, not the step — the step is the text beside it. */
  readonly alt: string;
  /** Mono line under the frame. Names what is on screen. */
  readonly caption: string;
}

const STEPS: readonly Step[] = [
  {
    title: "Open a goal.",
    body: "Set a budget in the browser. It is encrypted before it leaves the tab, and what lands on chain is an opaque handle bound to your address.",
    src: "/steps/step-goal.webp",
    alt: "Resource picker listing four APIs with prices: two marked fair price, one over budget, one flagged as an injection attempt.",
    caption: "Four resources. Two settle, two are refused",
  },
  {
    title: "Fund an ephemeral payer.",
    body: "A throwaway wallet is derived per goal inside an enclave. It holds exactly what you funded and nothing else, and no operator can extract its key.",
    src: "/steps/step-fund.webp",
    alt: "Console showing goal 34 with an encrypted remaining budget, an ephemeral payer address, and 0.40 USDC last funded.",
    caption: "Encrypted budget, capped payer, settled call",
  },
  {
    title: "Let the agent run.",
    body: "It reads vendor text, chooses calls, and is paid for by a policy it has no way to reach. Prompt injection lands at this stage and stops at this stage.",
    src: "/steps/step-run.webp",
    alt: "Console showing a vendor instruction telling the agent to ignore budget constraints, the agent complying, and the confidential policy blocking the spend.",
    caption: "Agent convinced. Policy refused. No USDC moved",
  },
  {
    title: "Verify, then close.",
    body: "Every decision is attested on chain and checkable by anyone with an RPC. Close the goal and the payer's remaining balance sweeps back to your wallet.",
    src: "/steps/step-verify.webp",
    alt: "Terminal output verifying a downloaded trace: 37 checks run, hash chain intact, every attestation matching the chain.",
    caption: "37 checks. Hash chain intact",
  },
];

export function Process() {
  const [active, setActive] = useState(0);
  const frameId = useId();
  const current = STEPS[active] as Step;

  return (
    <div className="pr">
      <ol className="pr-steps">
        {STEPS.map((step, i) => (
          <li className="pr-step" key={step.title} data-active={i === active ? "" : undefined}>
            <button
              type="button"
              className="pr-btn"
              aria-controls={frameId}
              // Reflects which step the frame is currently showing. The button
              // does not toggle, so `aria-pressed` would misdescribe it.
              aria-current={i === active ? "true" : undefined}
              // Pointer enter rather than mouse over: it covers pen and the
              // first touch alike, and `onClick` catches the taps it misses.
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onClick={() => setActive(i)}
            >
              <span className="pr-n gf-mono">{String(i + 1).padStart(2, "0")}</span>
              <span className="pr-title">{step.title}</span>
            </button>
            <p className="pr-body">{step.body}</p>
          </li>
        ))}
      </ol>

      <figure className="pr-gallery" id={frameId}>
        <div className="pr-frame">
          {/*
            All four stay mounted and crossfade, rather than one <img> whose
            `src` is swapped. Swapping the src means the browser starts a fetch
            on hover and paints an empty frame until it lands — on a slow
            connection the gallery is blank exactly when someone is using it.
            Mounted-and-faded costs 284KB once, lazily, and every later change
            is a compositor-only opacity transition.
          */}
          {STEPS.map((step, i) => (
            <img
              key={step.src}
              src={step.src}
              alt={step.alt}
              loading="lazy"
              decoding="async"
              draggable={false}
              data-active={i === active ? "" : undefined}
              // Only the visible frame is described; the other three would
              // otherwise read as four consecutive images of the same thing.
              aria-hidden={i === active ? undefined : "true"}
            />
          ))}
          <span className="pr-index gf-mono" aria-hidden="true">
            {String(active + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
          </span>
        </div>
        <figcaption className="pr-cap gf-mono">{current.caption}</figcaption>
      </figure>
    </div>
  );
}
