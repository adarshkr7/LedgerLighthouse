/**
 * HTTP surface for the orchestrator, so the browser can drive a run.
 *
 * The browser deliberately cannot do this itself. `requestSpend` and
 * `finalizeDecision` are submitted with the **relay key**, which stays on the
 * server — and, more to the point, a payment loop that needed the browser would
 * need the user present, which is the thing the ephemeral payer exists to avoid
 * (ARCHITECTURE.md §5.5). The UI opens the goal and funds the payer; everything after
 * that happens here, unattended.
 *
 *   GET  /health
 *   GET  /config          addresses and modes the UI needs to render honestly
 *   POST /runs            { goalId, mode } -> SSE stream of PaymentEvents
 *   POST /sweeps          { goalId } -> returns the payer balance to the owner
 *   GET  /traces/:goalId  the trace built from the last run for that goal
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { TraceBuilder } from "@ntux402/trace";
import {
  DEMO_GOAL_KEYS,
  findDemoGoal,
  validateQuery,
  vendorUpstreamOf,
} from "@ntux402/shared";
import { RateLimiter, corsHeaders, rejected } from "@ntux402/shared/node";
import type { Address } from "viem";

import type { PaymentEvent, PaymentLoop, PaymentResult } from "./pay/payment-loop.js";
import type { VaultRelay } from "./pay/relay.js";
import { TraceStore } from "./trace-store.js";
import type { TraceAnchorClient } from "./pay/anchor.js";
import { sweepGoal } from "./pay/sweep.js";

export interface OrchestratorServerOptions {
  readonly loop: PaymentLoop;
  readonly relay: VaultRelay;
  readonly vaultAddress: Address;
  readonly usdcAddress: Address;
  readonly chainId: number;
  readonly mockApiUrl: string;
  /** Base URL of `services/vendor-aisa`. Absent when live search is not configured. */
  readonly vendorAisaUrl: string | undefined;
  /**
   * `VENDOR_AISA_PAYEE`, republished so the console can allowlist it.
   *
   * A public address, not a credential — the vendor's *key* is fenced off from
   * this service by `scripts/check-boundary.mjs`, and this is deliberately not
   * that. The console needs it because an upstream goal's payee cannot live in
   * the shared catalog: it is the operator's own address.
   */
  readonly vendorAisaPayee: Address | undefined;
  readonly signerUrl: string;
  /**
   * Commits each finished trace root on chain. Absent when TRACE_ANCHOR_ADDRESS
   * is unset, which leaves traces tamper-evident but not time-stamped.
   */
  readonly anchors: TraceAnchorClient | undefined;
  readonly facilitatorUrl: string | undefined;
  readonly agentSource: "llm" | "scripted";
  /** Where completed traces are written. Defaults to `.traces`. */
  readonly traceDir?: string | undefined;
  readonly log?: (line: string) => void;
}

/*
 * The orchestrator is the untrusted component by design — it holds a gas key,
 * and the vault bounds what it can do. But "bounded" is not "free": a run burns
 * relay gas, consumes one of the goal's `callsRemaining`, and debits the
 * confidential budget. An open `POST /runs` therefore lets anyone who learns a
 * goal id exhaust a goal that someone is about to demo.
 *
 * So: loopback bind, origin allowlist, optional token, and a limiter sized to
 * a human driving a UI rather than a script.
 */
const RUN_LIMIT = new RateLimiter({ windowMs: 60_000, max: 20 });

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  cors: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body, (_k, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  res.writeHead(status, {
    ...cors,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Bounded so a hostile body cannot be used to exhaust memory — the signer and
 * the facilitator both capped theirs and this one did not, which made it the
 * cheapest process in the set to push over. Generous for what the routes
 * actually accept: the largest legitimate body is a goal id, a catalog key and
 * a query that `validateQuery` caps at 256 characters.
 */
const MAX_BODY_BYTES = 8 * 1024;

/** Distinguishable from a parse failure, so the two get different statuses. */
class BodyTooLarge extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLarge(`body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text === "" ? "null" : text);
}

/**
 * Answers a body that could not be read.
 *
 * An oversized body is a 413 and a malformed one is a 400: reporting the first
 * as "not valid JSON" would send an operator hunting for a syntax error in a
 * payload that was never parsed.
 */
function sendBodyError(res: ServerResponse, error: unknown, cors: Record<string, string>): void {
  if (error instanceof BodyTooLarge) {
    send(res, 413, { error: error.message }, cors);
    return;
  }
  send(res, 400, { error: "body: not valid JSON" }, cors);
}

export function createOrchestratorServer(options: OrchestratorServerOptions): Server {
  const log = options.log ?? (() => {});
  // Durable and bounded. See trace-store.ts for why this is a directory.
  const traces = new TraceStore(options.traceDir ?? ".traces");

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
      const path = (req.url ?? "/").split("?")[0] ?? "/";

      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      if (req.method === "GET" && path === "/health") {
        send(res, 200, { ok: true, service: "orchestrator" }, cors);
        return;
      }

      // Open like /health: the UI needs these addresses to render honestly, and
      // every one of them is already public on chain.
      if (req.method === "GET" && path === "/config") {
        send(
          res,
          200,
          {
            vaultAddress: options.vaultAddress,
            usdcAddress: options.usdcAddress,
            chainId: options.chainId,
            relayAddress: options.relay.relayAddress,
            signerUrl: options.signerUrl,
            mockApiUrl: options.mockApiUrl,
            // Both vendors are reported: one field cannot describe two servers,
            // and the console disables live search rather than offering a
            // button that 500s when the shim is not running.
            vendorAisaUrl: options.vendorAisaUrl,
            vendorAisaPayee: options.vendorAisaPayee,
            // Rendered in the UI so a stubbed run can never be mistaken for a real one.
            settlement: options.facilitatorUrl ? "live" : "stub",
            agent: options.agentSource,
          },
          cors,
        );
        return;
      }

      if (req.method === "GET" && path.startsWith("/traces/")) {
        const goalId = path.slice("/traces/".length);
        const trace = traces.get(goalId);
        if (!trace) {
          send(res, 404, { error: `no trace recorded for goal ${goalId}` }, cors);
          return;
        }
        send(res, 200, trace, cors);
        return;
      }

      if (req.method === "POST" && path === "/sweeps") {
        if (rejected(req, res, { limiter: RUN_LIMIT })) return;
        let body: unknown;
        try {
          body = await readJson(req);
        } catch (e) {
          sendBodyError(res, e, cors);
          return;
        }
        const { goalId } = (body ?? {}) as { goalId?: unknown };
        if (typeof goalId !== "string" || !/^[0-9]{1,32}$/.test(goalId)) {
          send(res, 400, { error: "goalId: expected a decimal string" }, cors);
          return;
        }

        const outcome = await sweepGoal(goalId, {
          signerUrl: options.signerUrl,
          facilitatorUrl: options.facilitatorUrl,
          usdcAddress: options.usdcAddress,
        });
        log(`POST /sweeps goal=${goalId} -> ${outcome.kind}`);

        if (outcome.kind === "settled") {
          send(res, 200, outcome, cors);
        } else if (outcome.kind === "refused") {
          send(res, outcome.status, { error: outcome.reason }, cors);
        } else {
          send(res, 502, { error: outcome.reason }, cors);
        }
        return;
      }

      if (req.method === "POST" && path === "/runs") {
        if (rejected(req, res, { limiter: RUN_LIMIT })) return;
        let body: unknown;
        try {
          body = await readJson(req);
        } catch (e) {
          sendBodyError(res, e, cors);
          return;
        }

        const { goalId, mode, priceAtomic, query } = (body ?? {}) as {
          goalId?: unknown;
          mode?: unknown;
          priceAtomic?: unknown;
          query?: unknown;
        };
        if (typeof goalId !== "string" || !/^[0-9]+$/.test(goalId)) {
          send(res, 400, { error: "goalId: expected a decimal string" }, cors);
          return;
        }
        // Validated against the shared catalog rather than a literal union, so
        // adding a resource is a catalog edit and not a change here. Anything
        // outside the catalog is rejected — this value becomes a URL path.
        if (typeof mode !== "string" || findDemoGoal(mode) === undefined) {
          send(res, 400, { error: `mode: expected one of ${DEMO_GOAL_KEYS.join(", ")}` }, cors);
          return;
        }

        // An upstream goal cannot run without the vendor that serves it. Said
        // here, at the request, rather than as a fetch failure twenty seconds
        // in with a goal already debited.
        const selectedGoal = findDemoGoal(mode);
        if (selectedGoal?.upstream !== undefined && options.vendorAisaUrl === undefined) {
          send(
            res,
            503,
            {
              error:
                `mode ${mode} is served by the live AIsa vendor, which is not configured. ` +
                `Fill in the live-search section of .env (see .env.example) and start ` +
                `@ntux402/vendor-aisa.`,
            },
            cors,
          );
          return;
        }

        // A demo control, forwarded verbatim to the mock vendor and used by
        // nothing else. It never reaches the policy: the amount the vault sees
        // comes from the 402 the vendor returns, parsed and re-derived there.
        if (priceAtomic !== undefined && !/^[0-9]{1,18}$/.test(String(priceAtomic))) {
          send(res, 400, { error: "priceAtomic: expected a decimal string" }, cors);
          return;
        }

        /*
         * The viewer's search text — the first input that travels *outward*
         * through this system. Everything else untrusted here arrives from a
         * vendor and flows toward the model; this goes browser -> orchestrator
         * -> vendor -> a paid API, so it is both an injection surface and a way
         * to spend money.
         *
         * Checked here so a bad one costs nothing: no chain write, no goal
         * debited, and a message the browser can show against the input. The
         * vendor checks it again on arrival, because it is the component
         * holding the key and this one is the component assumed compromised.
         * Same function, from the shared package, so the two cannot disagree.
         */
        let validatedQuery: string | undefined;
        if (query !== undefined && query !== null && query !== "") {
          if (selectedGoal?.upstream === undefined) {
            send(
              res,
              400,
              { error: `query: mode ${mode} does not take one — it is served from a fixture` },
              cors,
            );
            return;
          }
          const checked = validateQuery(query);
          if (!checked.ok) {
            send(res, 400, { error: checked.error }, cors);
            return;
          }
          validatedQuery = checked.value;
        }

        await streamRun(res, {
          ...options,
          cors,
          goalId: BigInt(goalId),
          mode,
          ...(priceAtomic === undefined ? {} : { priceAtomic: String(priceAtomic) }),
          ...(validatedQuery === undefined ? {} : { query: validatedQuery }),
          traces,
          log,
        });
        return;
      }

      send(res, 404, { error: "not found" }, cors);
    })().catch((e: unknown) => {
      if (!res.headersSent) {
        send(res, 500, { error: e instanceof Error ? e.message : String(e) }, cors);
      }
      else res.end();
    });
  });
}

/**
 * Which vendor serves this run, and at what URL.
 *
 * Routing is on the catalog entry's `upstream` field, never on the shape of the
 * key. A name-prefix rule (`mode.startsWith("aisa-")`) would send a renamed
 * goal to the wrong server, and the failure would be a 200 carrying the wrong
 * product at the right price — which is the one bug this catalog exists to
 * prevent.
 *
 * The query is URL-encoded into the path because it becomes the x402 `resource`
 * field, which `requireResource` demands be URL-shaped and which the vault
 * hashes into `termsHash`. A raw space would fail parsing; anything cleverer
 * would be smuggling path segments into what gets signed.
 */
export function resourceUrlFor(ctx: {
  mode: string;
  mockApiUrl: string;
  vendorAisaUrl?: string | undefined;
  priceAtomic?: string | undefined;
  query?: string | undefined;
}): string {
  const goal = findDemoGoal(ctx.mode);

  if (goal?.upstream !== undefined) {
    const params = new URLSearchParams({
      q: ctx.query ?? goal.upstream.defaultQuery,
      tier: goal.upstream.tier,
    });
    return `${ctx.vendorAisaUrl}/resource/aisa/${goal.upstream.capability}?${params.toString()}`;
  }

  // `?price=` is honoured by the mock vendor alone, and only for its overcharge
  // resource. It never reaches the policy: the amount the vault sees is
  // re-derived from the 402 that comes back.
  const query = ctx.priceAtomic ? `?price=${ctx.priceAtomic}` : "";
  return `${ctx.mockApiUrl}/resource/${ctx.mode}${query}`;
}

async function streamRun(
  res: ServerResponse,
  ctx: OrchestratorServerOptions & {
    cors: Record<string, string>;
    goalId: bigint;
    /** A key from the shared demo catalog; also the resource path segment. */
    mode: string;
    /** Demo-only price override, forwarded to the mock vendor. */
    priceAtomic?: string;
    /** Validated search text. Absent means the goal's own default query is used. */
    query?: string;
    traces: TraceStore;
    log: (line: string) => void;
  },
): Promise<void> {
  res.writeHead(200, {
    ...ctx.cors,
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Proxies that buffer would defeat the point of streaming the decision live.
    "x-accel-buffering": "no",
  });

  const emit = (event: string, data: unknown) => {
    res.write(
      `event: ${event}\ndata: ${JSON.stringify(data, (_k, v: unknown) =>
        typeof v === "bigint" ? v.toString() : v,
      )}\n\n`,
    );
  };

  const builder = new TraceBuilder({
    goalId: ctx.goalId,
    vault: ctx.vaultAddress,
    chainId: ctx.chainId,
  });

  const forward = (event: PaymentEvent) => {
    builder.record(event as unknown as { type: string });
    emit("payment", event);
  };

  const url = resourceUrlFor(ctx);
  ctx.log(`POST /runs goal=${ctx.goalId} mode=${ctx.mode} -> ${url}`);

  // Scoped to this run, not registered on the shared loop. `subscribe()` is
  // process-wide, so two concurrent runs would each receive the other's events
  // and each trace would record both goals.
  //
  // `fresh` because a POST to /runs is a person asking to buy the thing, not a
  // retry of an earlier attempt. Without it the process-wide response cache
  // answered the second run of a resource from memory: `kind: "free"`, no
  // `requestSpend`, no debit against the encrypted budget — while the catalog
  // copy invites the viewer to "run it several times and watch the encrypted
  // budget draw down". The run that demonstrates the product was the one the
  // cache swallowed.
  let result: PaymentResult;
  try {
    result = await ctx.loop.fetchPaid(url, ctx.goalId, { onEvent: forward, fresh: true });
  } catch (e) {
    emit("error", { message: e instanceof Error ? e.message : String(e) });
    res.end();
    return;
  }

  /*
   * The vendor's account of what it did with the money, recorded last.
   *
   * Last because that is when we learn it: the block arrives inside the final
   * 200 body, so the orchestrator cannot place it at the moment the upstream
   * call actually happened. Its timestamp is honestly "when this was learned",
   * and the only duration available is the vendor's own `latencyMs`.
   *
   * Recorded here rather than inside `PaymentLoop` on purpose. The loop is
   * generic x402 and knows nothing about which vendor served a resource or what
   * a `tier` is; teaching it would put vendor-specific parsing on the payment
   * path for the sake of a log line.
   */
  if (result.kind === "paid") {
    const upstream = vendorUpstreamOf(result.data);
    if (upstream) {
      const goal = findDemoGoal(ctx.mode);
      builder.record({
        type: "vendor-upstream",
        capability: goal?.upstream?.capability ?? "unknown",
        tier: goal?.upstream?.tier ?? "unknown",
        ...upstream,
      });
      if (
        upstream.costAtomic !== undefined &&
        upstream.quotedAtomic !== undefined &&
        BigInt(upstream.costAtomic) > BigInt(upstream.quotedAtomic)
      ) {
        // The shim absorbs the difference — a fixed-price offer that re-bills
        // after the fact is not one — but an overrun means the tier table is
        // stale, and that belongs somewhere a human reads.
        ctx.log(
          `vendor sold below cost on goal ${ctx.goalId}: quoted ${upstream.quotedAtomic}, ` +
            `cost ${upstream.costAtomic} (atomic). Re-run scripts/aisa-measure-tiers.mjs.`,
        );
      }
    }
  }

  const trace = builder.build();
  ctx.traces.save(ctx.goalId.toString(), trace);

  /*
   * Commit the root, when an anchor contract is configured.
   *
   * After the save, deliberately: the trace on disk is the artifact, and the
   * anchor is a commitment *to* it. Anchoring first and then failing to write
   * the file would leave a root on chain that nothing can be checked against.
   *
   * Awaited rather than fired and forgotten, so the SSE stream can report the
   * outcome while the viewer is still watching — but its failure never fails
   * the run. The money has moved and the record exists; losing the commitment
   * is not a reason to report the run as broken.
   */
  if (ctx.anchors) {
    const outcome = await ctx.anchors.anchor(
      ctx.vaultAddress,
      ctx.goalId,
      trace.root,
      trace.steps.length,
    );
    emit("anchor", outcome);
    ctx.log(
      outcome.kind === "anchored"
        ? `anchored goal=${ctx.goalId} root=${trace.root} tx=${outcome.txHash}`
        : `anchor goal=${ctx.goalId} -> ${outcome.kind}` +
          ("reason" in outcome ? `: ${outcome.reason}` : ""),
    );
  }

  emit("result", result);
  emit("trace", trace);
  res.end();
  ctx.log(`POST /runs goal=${ctx.goalId} mode=${ctx.mode} -> ${result.kind}`);
}
