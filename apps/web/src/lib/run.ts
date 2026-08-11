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
      source: "llm" | "scripted";
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

export type RunResult =
  | { kind: "free"; data: unknown }
  | { kind: "paid"; goalId: string; seq: string; terms: Terms; settlement?: Settlement }
  | { kind: "policy-rejected"; goalId: string; seq: string; decisionHandle: string; commitTx: string }
  | { kind: "decision-unavailable"; goalId: string; seq: string; attempts: number; elapsedMs: number }
  | { kind: "failed"; reason: string };

export async function* streamRun(
  goalId: string,
  /** A key from the shared demo catalog. The orchestrator validates it. */
  mode: string,
  signal?: AbortSignal,
): AsyncGenerator<RunEvent> {
  const response = await fetch(`${ORCHESTRATOR_URL}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goalId, mode }),
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
