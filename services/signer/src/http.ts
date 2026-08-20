/**
 * HTTP surface for the Authorization Signer. Two routes, and the shape of the
 * API *is* the security argument:
 *
 *   POST /payer           -> { address }        mint an ephemeral payer key
 *   POST /authorizations  -> { goalId, seq }    sign the finalized record
 *   POST /sweeps          -> { goalId }         return the payer balance to the owner
 *
 * There is no route that accepts an amount, a payee or a token, because there is
 * no code path that would know what to do with one. `node:http` rather than a
 * framework: fewer moving parts around the one component that holds a key.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { RateLimiter, corsHeaders, rejected } from "@ntux402/shared/node";

import type { AuthorizationSigner } from "./service.js";

/** Bounded so a hostile body cannot be used to exhaust memory. */
const MAX_BODY_BYTES = 8 * 1024;

/*
 * CORS is now an allowlist (localhost plus `CORS_ORIGINS`) rather than `*`, and
 * the process binds loopback unless told otherwise. See `guard.ts`.
 *
 * Worth restating what these routes do and do not expose, because it is easy to
 * over-read the risk. `POST /payer` generates a key and returns an address — a
 * caller can create unused keys, which grants nothing. `POST /authorizations`
 * takes only `(goalId, seq)` and signs only what the chain already finalized as
 * approved. The key never crosses this boundary in either direction.
 *
 * What was genuinely wrong was unbounded key *minting*: every call writes a new
 * private key to the file store, so a loop grew the file without limit. That is
 * what the limiter below is for.
 */

/** Key minting is cheap to call and expensive to serve. */
const MINT_LIMIT = new RateLimiter({ windowMs: 60_000, max: 30 });

/** Signing is chain-read-bound; the limit is generous but not absent. */
const SIGN_LIMIT = new RateLimiter({ windowMs: 60_000, max: 120 });

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
      const cors = corsHeaders(req);

      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      // Unguarded on purpose: a liveness probe that needs a credential is a
      // liveness probe that reports the credential rather than the service.
      if (req.method === "GET" && path === "/health") {
        send(res, 200, { ok: true, service: "authorization-signer" }, cors);
        return;
      }

      if (req.method === "POST" && path === "/payer") {
        if (rejected(req, res, { limiter: MINT_LIMIT })) return;
        const { address } = await signer.mintPayer();
        log(`POST /payer -> ${address}`);
        send(res, 201, { address }, cors);
        return;
      }

      if (req.method === "POST" && path === "/sweeps") {
        if (rejected(req, res, { limiter: SIGN_LIMIT })) return;
        let raw: string;
        try {
          raw = await readBody(req);
        } catch (e) {
          send(res, 413, { error: e instanceof Error ? e.message : String(e) }, cors);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw === "" ? "null" : raw);
        } catch {
          send(res, 400, { error: "body: not valid JSON" }, cors);
          return;
        }
        const outcome = await signer.sweep(parsed);
        if (!outcome.ok) {
          log(`POST /sweeps -> ${outcome.status} ${outcome.error}`);
          send(res, outcome.status, { error: outcome.error }, cors);
          return;
        }
        log(
          `POST /sweeps -> 200 signed goal ${outcome.value.goalId} ` +
            `value=${outcome.value.authorization.value} to=${outcome.value.authorization.to}`,
        );
        send(res, 200, outcome.value, cors);
        return;
      }

      if (req.method === "POST" && path === "/authorizations") {
        if (rejected(req, res, { limiter: SIGN_LIMIT })) return;
        let raw: string;
        try {
          raw = await readBody(req);
        } catch (e) {
          send(res, 413, { error: e instanceof Error ? e.message : String(e) }, cors);
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw === "" ? "null" : raw);
        } catch {
          send(res, 400, { error: "body: not valid JSON" }, cors);
          return;
        }

        const outcome = await signer.signRaw(parsed);
        if (!outcome.ok) {
          log(`POST /authorizations -> ${outcome.status} ${outcome.error}`);
          send(res, outcome.status, { error: outcome.error }, cors);
          return;
        }
        log(
          `POST /authorizations -> 200 signed (${outcome.value.goalId}, ${outcome.value.seq}) ` +
            `value=${outcome.value.authorization.value}`,
        );
        send(res, 200, outcome.value, cors);
        return;
      }

      send(res, 404, { error: "not found" }, cors);
    })().catch((e: unknown) => {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
}
