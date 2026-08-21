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
import { DEMO_GOAL_KEYS, findDemoGoal } from "@ntux402/shared";
import { RateLimiter, corsHeaders, rejected } from "@ntux402/shared/node";
import type { Address } from "viem";

import type { PaymentEvent, PaymentLoop, PaymentResult } from "./pay/payment-loop.js";
import type { VaultRelay } from "./pay/relay.js";
import { TraceStore } from "./trace-store.js";
import { sweepGoal } from "./pay/sweep.js";

export interface OrchestratorServerOptions {
  readonly loop: PaymentLoop;
  readonly relay: VaultRelay;
  readonly vaultAddress: Address;
  readonly usdcAddress: Address;
  readonly chainId: number;
  readonly mockApiUrl: string;
  readonly signerUrl: string;
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text === "" ? "null" : text);
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
        } catch {
          send(res, 400, { error: "body: not valid JSON" }, cors);
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
        } catch {
          send(res, 400, { error: "body: not valid JSON" }, cors);
          return;
        }

        const { goalId, mode, priceAtomic } = (body ?? {}) as {
          goalId?: unknown;
          mode?: unknown;
          priceAtomic?: unknown;
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

        // A demo control, forwarded verbatim to the mock vendor and used by
        // nothing else. It never reaches the policy: the amount the vault sees
        // comes from the 402 the vendor returns, parsed and re-derived there.
        if (priceAtomic !== undefined && !/^[0-9]{1,18}$/.test(String(priceAtomic))) {
          send(res, 400, { error: "priceAtomic: expected a decimal string" }, cors);
          return;
        }

        await streamRun(res, {
          ...options,
          cors,
          goalId: BigInt(goalId),
          mode,
          ...(priceAtomic === undefined ? {} : { priceAtomic: String(priceAtomic) }),
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

async function streamRun(
  res: ServerResponse,
  ctx: OrchestratorServerOptions & {
    cors: Record<string, string>;
    goalId: bigint;
    /** A key from the shared demo catalog; also the resource path segment. */
    mode: string;
    /** Demo-only price override, forwarded to the mock vendor. */
    priceAtomic?: string;
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

  const query = ctx.priceAtomic ? `?price=${ctx.priceAtomic}` : "";
  const url = `${ctx.mockApiUrl}/resource/${ctx.mode}${query}`;
  ctx.log(`POST /runs goal=${ctx.goalId} mode=${ctx.mode}${query}`);

  // Scoped to this run, not registered on the shared loop. `subscribe()` is
  // process-wide, so two concurrent runs would each receive the other's events
  // and each trace would record both goals.
  let result: PaymentResult;
  try {
    result = await ctx.loop.fetchPaid(url, ctx.goalId, { onEvent: forward });
  } catch (e) {
    emit("error", { message: e instanceof Error ? e.message : String(e) });
    res.end();
    return;
  }

  const trace = builder.build();
  ctx.traces.save(ctx.goalId.toString(), trace);

  emit("result", result);
  emit("trace", trace);
  res.end();
  ctx.log(`POST /runs goal=${ctx.goalId} mode=${ctx.mode} -> ${result.kind}`);
}
