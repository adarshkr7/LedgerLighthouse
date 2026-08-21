/**
 * Picks the agent implementation. The gateway-backed LLM when it has both an
 * API key and a model id, the scripted stand-in otherwise.
 *
 * The fallback is deliberate and not a degradation of the security claim: the
 * point being demonstrated is that *whatever* the agent concludes, it cannot
 * move money. A conference room with no network still gets to see that.
 *
 * **Both** are required now, not just the key. The gateway has no default model
 * — see `LlmAgentOptions.model` for why guessing one is worse than falling
 * back — so a key with no model id is not a usable configuration, and treating
 * it as one would surface as a 404 mid-run instead of a scripted agent at boot.
 */

import type { SpendAgent } from "../pay/payment-loop.js";

export interface AgentFactoryOptions {
  readonly apiKey: string | undefined;
  /** Gateway model id. No default; absent means the fallback is used. */
  readonly model: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly goal?: string | undefined;
  /** Used when the LLM is not fully configured. */
  readonly fallback: SpendAgent;
}

/** True when `buildAgent` will return a live LLM rather than the fallback. */
export function llmConfigured(options: {
  apiKey: string | undefined;
  model: string | undefined;
}): boolean {
  return Boolean(options.apiKey && options.model);
}

export async function buildAgent(options: AgentFactoryOptions): Promise<SpendAgent> {
  if (!llmConfigured(options)) return options.fallback;

  // Imported lazily so the module is not loaded on the offline path.
  const { LlmAgent } = await import("./llm.js");
  return new LlmAgent({
    apiKey: options.apiKey as string,
    model: options.model as string,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.goal === undefined ? {} : { goal: options.goal }),
  });
}
