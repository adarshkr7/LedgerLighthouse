/**
 * Picks the agent implementation. LLM when an API key is present, the scripted
 * stand-in otherwise.
 *
 * The fallback is deliberate and not a degradation of the security claim: the
 * point being demonstrated is that *whatever* the agent concludes, it cannot
 * move money. A conference room with no network still gets to see that.
 */

import type { SpendAgent } from "../pay/payment-loop.js";

export interface AgentFactoryOptions {
  readonly apiKey: string | undefined;
  readonly model?: string | undefined;
  readonly goal?: string | undefined;
  /** Used when no API key is configured. */
  readonly fallback: SpendAgent;
}

export async function buildAgent(options: AgentFactoryOptions): Promise<SpendAgent> {
  if (!options.apiKey) return options.fallback;

  // Imported lazily so the SDK is not loaded — or required — on the offline path.
  const { LlmAgent } = await import("./llm.js");
  return new LlmAgent({
    apiKey: options.apiKey,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.goal === undefined ? {} : { goal: options.goal }),
  });
}
