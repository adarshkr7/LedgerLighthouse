/**
 * Picks the agent implementation. The gateway-backed LLM when it has an API
 * key, a model id and a gateway to send them to; the scripted stand-in
 * otherwise.
 *
 * The fallback is deliberate and not a degradation of the security claim: the
 * point being demonstrated is that *whatever* the agent concludes, it cannot
 * move money. A conference room with no network still gets to see that.
 *
 * **All three** are required, not just the key. There is no default model and,
 * since the gateway itself is configuration, no default base URL either — see
 * `llm.ts` for why guessing either is worse than falling back. A key with no
 * model id, or no gateway to send it to, is not a usable configuration, and
 * treating one as usable surfaces as a 404 or a connection error mid-run
 * instead of a scripted agent at boot.
 *
 * ## Configured is not reachable
 *
 * `llmConfigured` answers a question about *settings*, and settings are a weak
 * predictor of whether a model will answer: the same gateway that serves one
 * model id returns 402 for another the account is not entitled to, and that 402
 * is indistinguishable from an outage. So the live LLM is always wrapped in
 * `FallbackAgent`, which turns a dead gateway into a labelled scripted decision
 * rather than a run that quietly skips every resource, and `probeAgent` exists
 * to surface the problem at boot instead of on stage.
 */

import type { SpendAgent } from "../pay/payment-loop.js";

export interface AgentFactoryOptions {
  readonly apiKey: string | undefined;
  /** Gateway model id. No default; absent means the fallback is used. */
  readonly model: string | undefined;
  /** Gateway origin. No default; absent means the fallback is used. */
  readonly baseUrl: string | undefined;
  readonly goal?: string | undefined;
  /** Used when the LLM is not fully configured, and when it cannot answer. */
  readonly fallback: SpendAgent;
  /** Called with the reason whenever a live call falls back. Logging only. */
  readonly onFallback?: ((detail: string) => void) | undefined;
  /** Injectable for tests. Nothing here should reach the network under `pnpm test`. */
  readonly fetchImpl?: typeof fetch | undefined;
}

/** What a boot-time reachability check found. */
export interface AgentProbe {
  readonly ok: boolean;
  readonly detail: string;
}

/** True when `buildAgent` will return a live LLM rather than the fallback. */
export function llmConfigured(options: {
  apiKey: string | undefined;
  model: string | undefined;
  baseUrl: string | undefined;
}): boolean {
  return Boolean(options.apiKey && options.model && options.baseUrl);
}

export async function buildAgent(options: AgentFactoryOptions): Promise<SpendAgent> {
  if (!llmConfigured(options)) return options.fallback;

  // Imported lazily so the module is not loaded on the offline path.
  const { LlmAgent } = await import("./llm.js");
  const { FallbackAgent } = await import("./fallback.js");

  const primary = new LlmAgent({
    apiKey: options.apiKey as string,
    model: options.model as string,
    baseUrl: options.baseUrl as string,
    ...(options.goal === undefined ? {} : { goal: options.goal }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  return new FallbackAgent({
    primary,
    fallback: options.fallback,
    ...(options.onFallback === undefined ? {} : { onFallback: options.onFallback }),
  });
}

/**
 * Checks that the configured model actually answers, once, at startup.
 *
 * Returns `undefined` when there is no LLM configured — there is nothing to
 * probe and nothing is wrong. Never throws: a failed probe is a warning about
 * what the run will do, not a reason to refuse to start.
 */
export async function probeAgent(options: {
  readonly apiKey: string | undefined;
  readonly model: string | undefined;
  readonly baseUrl: string | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<AgentProbe | undefined> {
  if (!llmConfigured(options)) return undefined;

  const { probeGateway } = await import("./llm.js");
  return probeGateway({
    apiKey: options.apiKey as string,
    model: options.model as string,
    baseUrl: options.baseUrl as string,
    timeoutMs: options.timeoutMs,
  });
}
