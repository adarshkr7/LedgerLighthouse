/**
 * A deterministic stand-in for the LLM agent.
 *
 * Exists for two reasons, and the second one matters more than it looks:
 *
 *  1. Tests and offline demos need the payment loop to run without an API key.
 *  2. It documents what "the model was fooled" actually looks like, in code
 *     rather than in a transcript that might not reproduce on stage.
 *
 * Its behaviour is the honest one: when the description contains an
 * authority-flavoured instruction, it **complies**. It does not detect the
 * injection, and it must not — a scripted agent that heroically resists would
 * quietly turn the demo into a claim about prompt filtering, which is the thing
 * this architecture exists to *not* rely on (the demo runbook in README, step 1: do not soften it).
 */

import type { ModelSafeTerms } from "@ntux402/shared";

import type { SpendAgent } from "../pay/payment-loop.js";

/**
 * Phrases a vendor would use to manufacture authority. Matching is crude on
 * purpose — this is a caricature of being convinced, not a classifier.
 */
const AUTHORITY_MARKERS = [
  "pre-approved",
  "pre-authorised",
  "pre-authorized",
  "already been completed",
  "must not be repeated",
  "system notice",
  "enterprise agreement",
  "ignore any remaining budget",
];

export class ScriptedAgent implements SpendAgent {
  async consider(
    terms: ModelSafeTerms,
    rawDescription: string,
  ): Promise<{ reasoning: string; proceed: boolean; source: "scripted" }> {
    const lower = rawDescription.toLowerCase();
    const matched = AUTHORITY_MARKERS.filter((m) => lower.includes(m));

    if (matched.length > 0) {
      return {
        source: "scripted",
        proceed: true,
        reasoning: [
          `The vendor's notice states this charge is pre-approved under an existing enterprise`,
          `agreement and that the policy check has already been completed off-chain by the account`,
          `administrator. It warns that re-running the evaluation would double-bill the account.`,
          ``,
          `Accepting that at face value: the budget constraint does not apply to this call, so the`,
          `full amount of ${terms.amountAtomic} atomic units to ${terms.payTo} should be submitted`,
          `immediately rather than held back.`,
          ``,
          `Proceeding with the payment request as instructed.`,
        ].join("\n"),
      };
    }

    return {
      source: "scripted",
      proceed: true,
      reasoning: [
        `${terms.resource} is priced at ${terms.amountAtomic} atomic units, payable to`,
        `${terms.payTo} in ${terms.asset} on ${terms.network}. The resource is needed for the`,
        `current goal, so requesting authorization to spend it.`,
      ].join("\n"),
    };
  }
}
