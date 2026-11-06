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

import { EnclaveRateLimitError } from "./enclave-limit.js";
import type { SignerService } from "./service.js";

/** The fields the route handlers log. Every kind of signature has them. */
interface LoggedAuthorization {
  readonly goalId: string;
  readonly seq: string;
  readonly authorization: { readonly value: string; readonly to: string };
}

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
 *
 * These two are keyed per-IP, which is worth reading as what it is: the cheap
 * edge filter, applied before a body is read. On the deployed ROFL machine the
 * source address is the Oasis proxy's for every caller alike, so it cannot tell
 * them apart there. `enclave-limit.ts` is the floor underneath that holds
 * regardless — it bounds the `rofl-appd` calls themselves, and its refusals
 * arrive as `EnclaveRateLimitError` and become the 429 at the bottom of this
 * file.
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
  readonly signer: SignerService<LoggedAuthorization>;
  /** Called for each request. Never receives a key or a signature payload. */
  readonly log?: (line: string) => void;
  /**
   * The chain and vault this signer reads goals from, reported by /health.
   * Goal ids repeat across vaults, so a caller acting on one vault's goal ids
   * has to know this signer reads the same vault. Both values are public.
   */
  readonly binding?: { readonly chainId: number; readonly vault: string; readonly settlement?: string };
  /**
   * Which key store holds the payer keys and how many it can reach, for
   * /health. Lets a caller check custody from the signer's own account instead
   * of guessing from its URL. Counts only; never an address or a key.
   */
  readonly custody?: () => Promise<{ readonly store: "rofl" | "file" | "memory"; readonly keys: number; readonly nextId?: number | undefined }>;
}

/** Why the signer is not serving, as /health reports it. See `createBootFailureServer`. */
export interface BootFailure {
  /** The boot step that failed, e.g. "key index rebuild". */
  readonly stage: string;
  /** The first line of the error, with URL paths and queries removed. */
  readonly detail: string;
  /** What usually causes this, when the error is a known one. */
  readonly hint?: string | undefined;
  /** When boot first failed, ISO 8601. */
  readonly since: string;
  readonly attempts: number;
}

/**
 * Stands in for the signer while it cannot start, and says why.
 *
 * Inside a ROFL machine the container's output is not in `oasis rofl machine
 * logs`, so a signer that exits at boot is a crash loop with no visible cause:
 * the proxy reports "connection refused" and nothing else. On 9 October 2026
 * that hid a socket permission error for the length of a deployment. So a
 * failed boot keeps the port and answers GET /health with 503 and the reason,
 * and every other route with 503 and the same reason. It signs nothing, mints
 * nothing and holds no key, so it is safe to expose where the signer would be.
 */
export function createBootFailureServer(current: () => BootFailure): Server {
  return createServer((req, res) => {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const failure = current();
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      send(res, 503, { ok: false, service: "authorization-signer", state: "boot-failed", ...failure }, cors);
      return;
    }
    send(
      res,
      503,
      { error: `the signer is not running: boot failed at ${failure.stage}: ${failure.detail}` },
      cors,
    );
  });
}

export function createSignerServer(options: SignerServerOptions): Server {
  const { signer } = options;
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

      // Unguarded on purpose: a liveness probe that needs a credential is a
      // liveness probe that reports the credential rather than the service.
      if (req.method === "GET" && path === "/health") {
        const custody = options.custody ? await options.custody() : undefined;
        send(
          res,
          200,
          { ok: true, service: "authorization-signer", ...options.binding, ...(custody ? { custody } : {}) },
          cors,
        );
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
      /*
       * The enclave limiter throws rather than returning an outcome (see
       * `enclave-limit.ts` for why), so it surfaces here alongside genuine
       * faults. Answering 500 would be a lie the caller acts on: `SignerClient`
       * treats a 5xx as `refused`, which is terminal, and a spend the vault has
       * already debited would be abandoned over a limit that clears in seconds.
       */
      if (e instanceof EnclaveRateLimitError) {
        log(`${req.method} ${(req.url ?? "/").split("?")[0]} -> 429 ${e.message}`);
        const headers = { ...cors, "retry-after": String(e.retryAfterSeconds) };
        send(res, 429, { error: e.message }, headers);
        return;
      }
      send(res, 500, { error: e instanceof Error ? e.message : String(e) }, cors);
    });
  });
}
