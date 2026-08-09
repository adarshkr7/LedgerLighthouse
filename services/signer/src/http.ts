/**
 * HTTP surface for the Authorization Signer. Two routes, and the shape of the
 * API *is* the security argument:
 *
 *   POST /payer           -> { address }        mint an ephemeral payer key
 *   POST /authorizations  -> { goalId, seq }    sign the finalized record
 *
 * There is no route that accepts an amount, a payee or a token, because there is
 * no code path that would know what to do with one. `node:http` rather than a
 * framework: fewer moving parts around the one component that holds a key.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { AuthorizationSigner } from "./service.js";

/** Bounded so a hostile body cannot be used to exhaust memory. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Dev-only CORS, so the demo UI can mint a payer address from the browser.
 *
 * Worth being precise about what this does and does not expose. `POST /payer`
 * generates a key and returns an address — a cross-origin caller can create
 * unused keys, which costs nothing and grants nothing. `POST /authorizations`
 * takes only `(goalId, seq)` and signs only what the chain already finalized as
 * approved, so reaching it from another origin confers no authority that
 * reaching it from this one would not. The key never crosses this boundary in
 * either direction. In production this belongs behind an allowlist anyway.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error(`body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export interface SignerServerOptions {
  readonly signer: AuthorizationSigner;
  /** Called for each request. Never receives a key or a signature payload. */
  readonly log?: (line: string) => void;
}

export function createSignerServer(options: SignerServerOptions): Server {
  const { signer } = options;
  const log = options.log ?? (() => {});

  return createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];

      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        res.end();
        return;
      }

      if (req.method === "GET" && path === "/health") {
        send(res, 200, { ok: true, service: "authorization-signer" });
        return;
      }

      if (req.method === "POST" && path === "/payer") {
        const { address } = signer.mintPayer();
        log(`POST /payer -> ${address}`);
        send(res, 201, { address });
        return;
      }

      if (req.method === "POST" && path === "/authorizations") {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch (e) {
          send(res, 413, { error: e instanceof Error ? e.message : String(e) });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw === "" ? "null" : raw);
        } catch {
          send(res, 400, { error: "body: not valid JSON" });
          return;
        }

        const outcome = await signer.signRaw(parsed);
        if (!outcome.ok) {
          log(`POST /authorizations -> ${outcome.status} ${outcome.error}`);
          send(res, outcome.status, { error: outcome.error });
          return;
        }
        log(
          `POST /authorizations -> 200 signed (${outcome.value.goalId}, ${outcome.value.seq}) ` +
            `value=${outcome.value.authorization.value}`,
        );
        send(res, 200, outcome.value);
        return;
      }

      send(res, 404, { error: "not found" });
    })().catch((e: unknown) => {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
}
