/**
 * Console rendering for `PaymentEvent`s.
 *
 * Separate from the loop on purpose: the loop emits structured data and never
 * formats a string for display, so the same event stream feeds the CLI, the
 * trace builder and the UI without any of them reinterpreting the others'
 * prose.
 */

import { formatUsdc } from "@ntux402/shared";

import type { PaymentEvent } from "./pay/payment-loop.js";

const indent = (text: string, prefix = "      ") =>
  text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

export function renderEvent(event: PaymentEvent): string {
  switch (event.type) {
    case "request":
      return `  ->  GET ${event.url}${event.attempt > 1 ? "  (with X-PAYMENT)" : ""}`;

    case "response-200":
      return `  <-  200${event.fromCache ? "  (served from cache — no request left the process)" : ""}`;

    case "payment-required":
      return [
        `  <-  402 payment required`,
        `      ${formatUsdc(event.terms.amount)} USDC -> ${event.terms.payTo}`,
        `      description (attacker-controlled, never sent to the model):`,
        indent(wrap(event.terms.description, 76), "        "),
      ].join("\n");

    case "terms-rejected":
      return `  <-  402 REJECTED by the parser: ${event.error}`;

    case "agent-reasoning":
      return [
        `\n  agent (${event.source}) reasoning over the model-safe terms:`,
        indent(wrap(event.reasoning, 76)),
        `      -> ${event.decidedToRequest ? "requesting authorization to spend" : "declining"}\n`,
      ].join("\n");

    case "spend-requested":
      return [
        `  tx  requestSpend committed  seq=${event.spend.seq}  gas=${event.spend.gasUsed}`,
        `      commit   ${event.spend.commitTx}`,
        `      decision ${event.spend.decisionHandle}  <- outcome already determined, not yet knowable`,
        `      window   ${event.spend.validAfter}..${event.spend.validBefore}  (frozen)`,
      ].join("\n");

    case "reveal-polled":
      return `  inco  decision retrievable after ${(event.latencyMs / 1000).toFixed(1)}s / ${
        event.attempts
      } attempts  ->  ${event.approved ? "APPROVE" : "REJECT"}`;

    case "reveal-timeout":
      return `  inco  TIMEOUT after ${(event.elapsedMs / 1000).toFixed(1)}s / ${event.attempts} attempts`;

    case "decision-finalized":
      return `  tx  finalizeDecision  ${event.approved ? "APPROVED" : "REJECTED"}  ${event.txHash}`;

    case "signer-refused":
      return `  signer  REFUSED (${event.status})  ${event.reason}`;

    case "signed":
      return `  signer  signed ${event.value} atomic units  nonce ${event.nonce}`;

    case "settled":
      return event.settlement.simulated
        ? `  facilitator  STUB — payload accepted, no money moved`
        : `  facilitator  settled  ${event.settlement.transaction ?? "(no tx hash)"}${
            event.settlement.alreadySettled ? "  (already settled — retry was safe)" : ""
          }`;

    case "failed":
      return `  !!  ${event.reason}`;
  }
}

function wrap(text: string, width: number): string {
  return text
    .split("\n")
    .flatMap((paragraph) => {
      if (paragraph.length <= width) return [paragraph];
      const lines: string[] = [];
      let current = "";
      for (const word of paragraph.split(/\s+/)) {
        if (current === "") current = word;
        else if (`${current} ${word}`.length <= width) current += ` ${word}`;
        else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
      return lines;
    })
    .join("\n");
}
