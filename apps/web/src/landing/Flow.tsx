/**
 * The payment path, as a grid of stage cards.
 *
 * Laid out the way the reference site lays out selected work: large flat
 * rectangles on the section's own background, a rule above each title, and a
 * mono tag row underneath. The first card is deliberately wider than the rest
 * — an even 7-up grid reads as a table of contents, and the first stage is
 * the one the reader has to accept before any of the others mean anything.
 *
 * Hover borrows Canvas UI's "Peel": a second layer lifts in from the bottom
 * edge and covers the card, carrying the line that actually makes the stage
 * matter. Peeling rather than fading is what keeps the two layers legible as
 * *two* — a crossfade at this size just looks like the text is broken.
 *
 * The hostile stage carries `data-kind="hostile"` and turns brand orange on
 * hover. That is the single non-CTA use of colour on the page, and it is
 * spent on the one stage an attacker can actually reach. Nothing else here
 * needs a colour to be understood.
 */

export type StageKind = "user" | "cipher" | "hostile" | "settle";

export interface FlowStep {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly kind: StageKind;
  /** The line that makes this stage matter. Revealed by the peel. */
  readonly detail: string;
  /** Mono tags under the title, in the reference site's bracketed style. */
  readonly tags: readonly string[];
}

/**
 * Deliberately the real pipeline, in order, with the honest names. A deck that
 * said "AI decides" where the system says "confidential policy evaluates"
 * would be the one place on this page that oversells.
 */
export const FLOW_STEPS: readonly FlowStep[] = [
  {
    id: "wallet",
    label: "User Wallet",
    note: "Signs once. Never in the loop.",
    kind: "user",
    detail:
      "Three signatures total: open the goal, fund the payer, close it. Nothing during a run.",
    tags: ["HUMAN", "EIP-1193"],
  },
  {
    id: "goal",
    label: "Encrypted Goal",
    note: "Budget encrypted in the browser.",
    kind: "cipher",
    detail:
      "The ciphertext is bound to your address. On chain it is an opaque bytes32 handle.",
    tags: ["CIPHERTEXT", "BYTES32"],
  },
  {
    id: "agent",
    label: "AI Agent",
    note: "Reads vendor text. Holds no key.",
    kind: "hostile",
    detail:
      "This is where the injection lands. The agent can be fully convinced — it holds only a gas key.",
    tags: ["UNTRUSTED", "NO SPEND AUTHORITY"],
  },
  {
    id: "policy",
    label: "Confidential Policy",
    note: "Evaluated inside a TEE.",
    kind: "cipher",
    detail:
      "The debit is applied before the answer is knowable, because you cannot branch on a secret.",
    tags: ["INCO", "TEE"],
  },
  {
    id: "record",
    label: "Finalized Record",
    note: "Decision committed on chain.",
    kind: "cipher",
    detail:
      "The attestation is verified against the handle the contract stored, not one the caller supplies.",
    tags: ["ATTESTED", "HANDLE-MATCHED"],
  },
  {
    id: "payer",
    label: "Ephemeral Payer",
    note: "Key derived in an enclave.",
    kind: "settle",
    detail: "Per goal, holding only what you funded. No operator can extract the key.",
    tags: ["PER-GOAL", "CAPPED"],
  },
  {
    id: "settle",
    label: "x402 Settlement",
    note: "EIP-3009 on Base Sepolia.",
    kind: "settle",
    detail: "Gasless, single-use, and shaped exactly as the chain froze it.",
    tags: ["X402", "EIP-3009"],
  },
];

export function Flow() {
  return (
    <ol className="gf-work">
      {FLOW_STEPS.map((step, i) => (
        <li className="gf-work-card" key={step.id} data-kind={step.kind}>
          {/* Focusable so the peel is reachable without a pointer; the card is
              not a link, so a plain tabindex is the honest control here. */}
          <div className="gf-work-inner" tabIndex={0}>
            <div className="gf-work-face">
              <span className="gf-work-n">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="gf-work-title">{step.label}</h3>
              <p className="gf-work-note">{step.note}</p>
              <p className="gf-work-tags">
                {step.tags.map((tag, t) => (
                  <span key={tag}>
                    {t > 0 ? <i aria-hidden="true">—</i> : null}[{tag}]
                  </span>
                ))}
              </p>
            </div>
            {/* The peel layer. Not aria-hidden: the detail is real content and
                a keyboard reader should get it in order. */}
            <div className="gf-work-peel">
              <p>{step.detail}</p>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
