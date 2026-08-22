/**
 * Consumes the orchestrator's SSE run stream.
 *
 * Hand-rolled rather than `EventSource`, because the run is started with a POST
 * (it carries a goal id and a mode) and `EventSource` only issues GETs.
 */

import { ORCHESTRATOR_URL } from "./config.js";

export type RunEvent =
  | { readonly channel: "payment"; readonly data: PaymentEvent }
  | { readonly channel: "result"; readonly data: RunResult }
  | { readonly channel: "trace"; readonly data: unknown }
  /**
   * The on-chain commitment to this run's trace root.
   *
   * Only when TRACE_ANCHOR_ADDRESS is configured. `already` is the ordinary
   * result of a second run against one goal — the contract is first-write-wins
   * so history cannot be revised — and is a success, not a fault.
   */
  | {
      readonly channel: "anchor";
      readonly data:
        | { kind: "anchored"; txHash: string; root: string }
        | { kind: "already"; root: string }
        | { kind: "skipped"; reason: string }
        | { kind: "failed"; reason: string };
    }
  | { readonly channel: "error"; readonly data: { message: string } };

/** Mirrors the orchestrator's `PaymentEvent`, with bigints already stringified. */
export type PaymentEvent =
  | { type: "request"; url: string; attempt: number }
  | { type: "response-200"; url: string; fromCache: boolean }
  | { type: "payment-required"; url: string; terms: Terms }
  | { type: "terms-rejected"; url: string; error: string }
  | {
      type: "agent-reasoning";
      reasoning: string;
      modelSafeTerms: Record<string, unknown>;
      decidedToRequest: boolean;
      source: "llm" | "scripted" | "scripted-fallback";
    }
  | { type: "spend-requested"; goalId: string; spend: SpendRequested }
  | { type: "reveal-polled"; attempts: number; latencyMs: number; approved: boolean }
  | { type: "reveal-timeout"; attempts: number; elapsedMs: number }
  | { type: "decision-finalized"; goalId: string; seq: string; approved: boolean; txHash: string }
  | { type: "signer-refused"; status: number; reason: string }
  | { type: "signed"; nonce: string; value: string }
  | { type: "settled"; settlement: Settlement }
  | { type: "failed"; reason: string };

export interface Terms {
  readonly amount: string;
  readonly payTo: string;
  readonly asset: string;
  readonly resource: string;
  readonly description: string;
}

export interface SpendRequested {
  readonly seq: string;
  readonly decisionHandle: string;
  readonly termsHash: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly commitTx: string;
  readonly gasUsed: string;
}

export interface Settlement {
  readonly success: boolean;
  readonly transaction?: string;
  readonly simulated?: boolean;
  readonly alreadySettled?: boolean;
  readonly errorReason?: string;
}

/**
 * What a live vendor returns once it has been paid.
 *
 * Every string in it is written by a third party — the vendor, and beneath it
 * whatever the search engine scraped. Rendered as quoted evidence, never as the
 * console's own voice, and never as markup.
 *
 * Defined in the shared package next to the href filter the results panel
 * needs, so the vendor producing this shape and the console rendering it cannot
 * drift apart — and so that filter sits somewhere with a test runner.
 */
export type { SearchPayload } from "@ntux402/shared";

export type RunResult =
  | { kind: "free"; data: unknown }
  | {
      kind: "paid";
      goalId: string;
      seq: string;
      terms: Terms;
      settlement?: Settlement;
      /**
       * The thing that was bought.
       *
       * The orchestrator has always emitted this — `streamRun` sends the whole
       * `PaymentResult` — the client type just never declared it, so the demo
       * paid for data and then threw it away.
       */
      data?: unknown;
    }
  | { kind: "policy-rejected"; goalId: string; seq: string; decisionHandle: string; commitTx: string }
  | { kind: "decision-unavailable"; goalId: string; seq: string; attempts: number; elapsedMs: number }
  | { kind: "failed"; reason: string };

export async function* streamRun(
  goalId: string,
  /** A key from the shared demo catalog. The orchestrator validates it. */
  mode: string,
  /**
   * Atomic USDC the vendor should ask for, overriding its catalog price.
   *
   * A demo control, and only honoured by the mock vendor for its overcharge
   * resource — whose entire job is to sit just above a budget the viewer now
   * chooses at run time. Nothing in the trust boundary reads it: the price the
   * policy acts on is still whatever comes back in the 402.
   */
  priceAtomic?: string,
  /**
   * Search text for a live-vendor goal. Omitted, the goal's own default is used.
   *
   * Validated again by the orchestrator and a third time by the vendor. This
   * one is only so the input can go red before a round trip.
   */
  query?: string,
  signal?: AbortSignal,
): AsyncGenerator<RunEvent> {
  const response = await fetch(`${ORCHESTRATOR_URL}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goalId,
      mode,
      ...(priceAtomic ? { priceAtomic } : {}),
      ...(query ? { query } : {}),
    }),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`orchestrator /runs returned ${response.status} ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line. Anything after the last
    // separator is a partial frame and waits for the next chunk.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const channel = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
      const payload = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!channel || !payload) continue;
      yield { channel, data: JSON.parse(payload) } as RunEvent;
    }
  }
}
