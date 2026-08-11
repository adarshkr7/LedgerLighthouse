import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { handleRequest, type HandlerOptions } from "./handler.js";

export interface StartedServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export function createMockApi(options: HandlerOptions = {}): Server {
  return createServer((req, res) => {
    void (async () => {
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }

      // Query string included: the handler needs `?price=` for the overcharge
      // vendor. It splits the two apart itself, and the `resource` it advertises
      // is built from the bare path.
      const parsed = new URL(req.url ?? "/", "http://localhost");
      const path = `${parsed.pathname}${parsed.search}`;
      const result = await handleRequest({ method: req.method ?? "GET", path, headers }, options);

      res.writeHead(result.status, result.headers);
      res.end(JSON.stringify(result.body));
    })().catch((e: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });
}

/** Binds on an ephemeral port unless one is given — keeps parallel tests from colliding. */
export function startMockApi(port = 0, options: HandlerOptions = {}): Promise<StartedServer> {
  const server = createMockApi(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const { port: boundPort } = server.address() as AddressInfo;
      resolve({
        server,
        port: boundPort,
        url: `http://127.0.0.1:${boundPort}`,
        close: () =>
          new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
