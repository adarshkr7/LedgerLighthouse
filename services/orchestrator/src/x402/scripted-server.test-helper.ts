/**
 * A tiny HTTP server whose responses are scripted per-request, so retry,
 * backoff and cache behaviour can be driven deterministically against real
 * sockets rather than a stubbed `fetch`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ScriptedResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Emit a body that is not valid JSON, to exercise the parse-failure branch. */
  readonly rawBody?: string;
}

export interface ScriptedServer {
  readonly url: string;
  /** Every request received, in order. */
  readonly requests: ReadonlyArray<{ path: string; headers: Record<string, string | undefined> }>;
  get hits(): number;
  close(): Promise<void>;
}

/**
 * `script` is consumed one entry per request; once exhausted the final entry
 * repeats, so "fail twice then succeed forever" is a two-element script.
 */
export function startScriptedServer(script: readonly ScriptedResponse[]): Promise<ScriptedServer> {
  if (script.length === 0) throw new Error("script must not be empty");

  const requests: Array<{ path: string; headers: Record<string, string | undefined> }> = [];

  const server: Server = createServer((req, res) => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }
    requests.push({ path: req.url ?? "/", headers });

    const step = script[Math.min(requests.length - 1, script.length - 1)]!;
    res.writeHead(step.status, { "content-type": "application/json", ...step.headers });
    res.end(step.rawBody !== undefined ? step.rawBody : JSON.stringify(step.body ?? {}));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        get hits() {
          return requests.length;
        },
        close: () =>
          new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done()))),
      });
    });
  });
}
