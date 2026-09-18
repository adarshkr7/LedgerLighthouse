import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { bindHost } from "@ntux402/shared/node";

import { handleRequest, type HandlerOptions } from "./handler.js";

export interface StartedServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export function createVendorApi(options: HandlerOptions): Server {
  return createServer((req, res) => {
    void (async () => {
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }

      // Query string included: the handler needs `sku`, `minutes` and
      // `workload`, and builds the advertised `resource` from the same request
      // line so the 402 and the paid retry cannot disagree about what was
      // bought.
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

/**
 * Binds on an ephemeral port unless one is given — keeps parallel tests from
 * colliding.
 *
 * Bind address comes from the shared guard, which defaults to loopback. This
 * service holds a key that allocates real hardware on an external account, so
 * reaching it from the network is a decision someone has to make on purpose.
 *
 * One note on timeouts. A rental request stays open for the length of the block
 * it bought, and node's default `requestTimeout` is five minutes — shorter than
 * the 30- and 60-minute blocks on offer, which would cut the connection on a
 * job the vendor then finishes and bills for. It is set from the longest block
 * plus the same margin the 402 advertises.
 */
export function startVendorApi(port = 0, options: HandlerOptions): Promise<StartedServer> {
  const server = createVendorApi(options);
  const host = bindHost();

  // 60-minute block + 5 minutes, matching `maxTimeoutSeconds` in the 402.
  server.requestTimeout = (60 * 60 + 300) * 1000;
  server.headersTimeout = 60_000;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const { port: boundPort } = server.address() as AddressInfo;
      resolve({
        server,
        port: boundPort,
        url: `http://${host}:${boundPort}`,
        close: () =>
          new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
