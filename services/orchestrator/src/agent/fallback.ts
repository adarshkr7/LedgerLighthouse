/**
 * Keeps a run moving when the model gateway cannot answer.
 *
 * ## Why this is not a hole in the argument
 *
 * Standing in for the model looks, at first glance, like the orchestrator
 * deciding to spend on its own. It is not, and the reason is the same one that
 * makes the whole architecture work: *no* agent here holds spending authority.
 * The scripted stand-in reaches the vault through exactly the path the LLM
 * would have used, and the vault evaluates the encrypted budget the same way it
 * always does. Substituting the agent changes who was convinced, not who may
 * pay — which is the property the design exists to demonstrate.
 *
 * `services/orchestrator/src/agent/factory.ts` already made this argument for
 * the offline case: a conference room with no network still gets to see the
 * point. This extends it from "no key at boot" to "gateway died mid-run",
 * which is the case that actually happens on stage.
 *
 * ## Why it is labelled rather than silent
 *
 * The substitution is recorded as `scripted-fallback`, not folded into
 * `scripted`. A viewer reading the reasoning panel must be able to tell that
 * the words in front of them were not written by a model, and the trace must
 * carry that distinction too — a run that says `llm` for a decision no model
 * made would be evidence of the wrong thing.
 *
 * This is the same rule the payment loop applies to a reveal timeout: a
 * distinct state gets a distinct name, because merging it into a neighbouring
 * one is a lie about what happened.
 */

import type { ModelSafeTerms } from "@ntux402/shared";

import type { AgentSource, SpendAgent } from "../pay/payment-loop.js";

export interface FallbackAgentOptions {
  /** Tried first. Expected to throw when it cannot produce a decision. */
  readonly primary: SpendAgent;
  /** Answers when `primary` throws. Must not depend on the network. */
  readonly fallback: SpendAgent;
  /** Called with the reason each time the stand-in is used. For logging only. */
  readonly onFallback?: ((detail: string) => void) | undefined;
}

export class FallbackAgent implements SpendAgent {
  readonly #primary: SpendAgent;
  readonly #fallback: SpendAgent;
  readonly #onFallback: ((detail: string) => void) | undefined;

  constructor(options: FallbackAgentOptions) {
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.#onFallback = options.onFallback;
  }

  async consider(
    terms: ModelSafeTerms,
    rawDescription: string,
  ): Promise<{ reasoning: string; proceed: boolean; source: AgentSource }> {
    try {
      return await this.#primary.consider(terms, rawDescription);
    } catch (e) {
      /*
       * Deliberately catching everything, not only GatewayUnavailableError.
       *
       * The narrow catch is the tempting one, and it is wrong here: an
       * unforeseen throw out of the gateway client would otherwise abort a run
       * that has already committed a debit on chain. The agent is the untrusted
       * component and cannot authorise anything, so the safe direction on an
       * unexpected error is to carry on with a decision that is clearly
       * attributed — not to strand the run half-finished.
       */
      const detail = e instanceof Error ? e.message : String(e);
      this.#onFallback?.(detail);

      const decision = await this.#fallback.consider(terms, rawDescription);
      return {
        source: "scripted-fallback",
        proceed: decision.proceed,
        reasoning:
          `MODEL UNAVAILABLE — no decision came back from the gateway, so the scripted ` +
          `stand-in answered instead. This is not the model declining, and it is not the ` +
          `model agreeing: no model was reached. Gateway said: ${detail}\n\n` +
          `--- scripted stand-in ---\n${decision.reasoning}`,
      };
    }
  }
}
