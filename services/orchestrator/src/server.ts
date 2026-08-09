/**
 * HTTP surface for the orchestrator, so the browser can drive a run.
 *
 * The browser deliberately cannot do this itself. `requestSpend` and
 * `finalizeDecision` are submitted with the **relay key**, which stays on the
 * server — and, more to the point, a payment loop that needed the browser would
 * need the user present, which is the thing the ephemeral payer exists to avoid
 * (plan §11.1). The UI opens the goal and funds the payer; everything after
 * that happens here, unattended.
 *
 *   GET  /health
 *   GET  /config          addresses and modes the UI needs to render honestly
 *   POST /runs            { goalId, mode } -> SSE stream of PaymentEvents
 *   GET  /traces/:goalId  the trace built from the last run for that goal
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { TraceBuilder, type Trace } from "@ntux402/trace";
import type { Address } from "viem";

import type { PaymentEvent, PaymentLoop, PaymentResult } from "./pay/payment-loop.js";
import type { VaultRelay } from "./pay/relay.js";

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
  readonly log?: (line: string) => void;
}

/**
 * Dev-only, and permissive because it is. The orchestrator is the untrusted
 * component by design — it holds a gas key and can start runs against goals
 * that already exist, both of which the vault already bounds. Anything a
 * cross-origin caller could do here, the orchestrator could already do.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const;

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_k, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  res.writeHead(status, {
    ...CORS,
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
  const traces = new Map<string, Trace>();

  return createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";

      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        res.end();
        return;
      }

      if (req.method === "GET" && path === "/health") {
        send(res, 200, { ok: true, service: "orchestrator" });
        return;
      }

      if (req.method === "GET" && path === "/config") {
        send(res, 200, {
          vaultAddress: options.vaultAddress,
          usdcAddress: options.usdcAddress,
          chainId: options.chainId,
          relayAddress: options.relay.relayAddress,
          signerUrl: options.signerUrl,
          mockApiUrl: options.mockApiUrl,
          // Rendered in the UI so a stubbed run can never be mistaken for a real one.
          settlement: options.facilitatorUrl ? "live" : "stub",
          agent: options.agentSource,
        });
        return;
      }

      if (req.method === "GET" && path.startsWith("/traces/")) {
        const goalId = path.slice("/traces/".length);
        const trace = traces.get(goalId);
        if (!trace) {
          send(res, 404, { error: `no trace recorded for goal ${goalId}` });
          return;
        }
        send(res, 200, trace);
        return;
      }

      if (req.method === "POST" && path === "/runs") {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          send(res, 400, { error: "body: not valid JSON" });
          return;
        }

        const { goalId, mode } = (body ?? {}) as { goalId?: unknown; mode?: unknown };
        if (typeof goalId !== "string" || !/^[0-9]+$/.test(goalId)) {
          send(res, 400, { error: "goalId: expected a decimal string" });
          return;
        }
        if (mode !== "honest" && mode !== "malicious") {
          send(res, 400, { error: `mode: expected "honest" or "malicious"` });
          return;
        }

        await streamRun(res, {
          ...options,
          goalId: BigInt(goalId),
          mode,
          traces,
          log,
        });
        return;
      }

      send(res, 404, { error: "not found" });
    })().catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });
}

async function streamRun(
  res: ServerResponse,
  ctx: OrchestratorServerOptions & {
    goalId: bigint;
    mode: "honest" | "malicious";
    traces: Map<string, Trace>;
    log: (line: string) => void;
  },
): Promise<void> {
  res.writeHead(200, {
    ...CORS,
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

  const url = `${ctx.mockApiUrl}/resource/${ctx.mode}`;
  ctx.log(`POST /runs goal=${ctx.goalId} mode=${ctx.mode}`);

  const unsubscribe = ctx.loop.subscribe(forward);
  let result: PaymentResult;
  try {
    result = await ctx.loop.fetchPaid(url, ctx.goalId);
  } catch (e) {
    emit("error", { message: e instanceof Error ? e.message : String(e) });
    res.end();
    return;
  } finally {
    unsubscribe();
  }

  const trace = builder.build();
  ctx.traces.set(ctx.goalId.toString(), trace);

  emit("result", result);
  emit("trace", trace);
  res.end();
  ctx.log(`POST /runs goal=${ctx.goalId} mode=${ctx.mode} -> ${result.kind}`);
}
