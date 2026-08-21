/**
 * HTTP surface matching the hosted x402 facilitator shape:
 *
 *   POST /verify   { paymentPayload, paymentRequirements } -> { isValid, invalidReason?, payer? }
 *   POST /settle   { paymentPayload, paymentRequirements } -> { success, transaction?, ... }
 *   GET  /supported                                        -> the kinds we settle
 *
 * Both bodies are parsed strictly. A facilitator that coerces its input is a
 * facilitator that can be argued into settling something nobody signed.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  SCHEME_EXACT,
  X402_VERSION,
  parsePaymentPayload,
  parsePaymentRequirements,
} from "@ntux402/shared";

import { RateLimiter, corsHeaders, rejected } from "@ntux402/shared/node";

import type { Facilitator } from "./facilitator.js";

const MAX_BODY_BYTES = 32 * 1024;

/*
 * `POST /settle` spends this service's gas on behalf of whoever calls it. The
 * authorization it submits is signed, so nobody can make it move funds they do
 * not control — but they can make it burn gas, one failed transaction at a
 * time. The limiter is the bound on that; the loopback default is the reason it
 * rarely matters.
 */
const SETTLE_LIMIT = new RateLimiter({ windowMs: 60_000, max: 60 });

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error(`body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text === "" ? "null" : text);
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  cors: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...cors,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export interface FacilitatorServerOptions {
  readonly facilitator: Facilitator;
  readonly network: string;
  readonly log?: (line: string) => void;
}

export function createFacilitatorServer(options: FacilitatorServerOptions): Server {
  const { facilitator, network } = options;
  const log = options.log ?? (() => {});

  return createServer((req, res) => {
    /*
     * Computed once, out here rather than inside the async frame, so the
     * `.catch()` below can reach it too. It could not before, and a crash
     * therefore answered without CORS headers -- which the browser reports as
     * an opaque "Failed to fetch" rather than the 500 and its message. That is
     * precisely the failure this project spent an afternoon misdiagnosing: the
     * service was up and answering, and the only thing wrong was that the
     * answer was unreadable.
     */
    const cors = corsHeaders(req);

    void (async () => {
      const path = (req.url ?? "/").split("?")[0];

      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      // Everything but the two probes is guarded.
      if (path !== "/health" && path !== "/supported") {
        if (rejected(req, res, { limiter: SETTLE_LIMIT })) return;
      }

      if (req.method === "GET" && path === "/health") {
        send(res, 200, { ok: true, service: "x402-facilitator", settler: facilitator.settlerAddress }, cors);
        return;
      }

      if (req.method === "GET" && path === "/supported") {
        send(res, 200, { kinds: [{ x402Version: X402_VERSION, scheme: SCHEME_EXACT, network }] }, cors);
        return;
      }

      if (req.method !== "POST" || (path !== "/verify" && path !== "/settle")) {
        send(res, 404, { error: "not found" }, cors);
        return;
      }

      let body: unknown;
      try {
        body = await readJson(req);
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) }, cors);
        return;
      }

      if (typeof body !== "object" || body === null) {
        send(res, 400, { error: "body: expected an object" }, cors);
        return;
      }
      const envelope = body as Record<string, unknown>;

      const payment = parsePaymentPayload(envelope["paymentPayload"]);
      if (!payment.ok) {
        send(res, 400, { error: payment.error }, cors);
        return;
      }
      const requirements = parsePaymentRequirements(envelope["paymentRequirements"]);
      if (!requirements.ok) {
        send(res, 400, { error: requirements.error }, cors);
        return;
      }

      if (path === "/verify") {
        const result = await facilitator.verify(payment.value, requirements.value);
        log(`POST /verify -> ${result.isValid ? "valid" : `invalid: ${result.invalidReason}`}`);
        send(res, 200, result, cors);
        return;
      }

      const result = await facilitator.settle(payment.value, requirements.value);
      log(
        `POST /settle -> ${
          result.success
            ? `${result.alreadySettled ? "already settled" : "settled"} ${result.transaction ?? ""}`
            : `failed: ${result.errorReason}`
        }`,
      );
      send(res, result.success ? 200 : 402, result, cors);
    })().catch((e: unknown) => {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) }, cors);
    });
  });
}
