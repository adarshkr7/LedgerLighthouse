import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { createBootFailureServer, createSignerServer, type SignerServerOptions } from "./http.js";
import type { EscrowAuthorizationSigner } from "./escrow-service.js";

async function health(binding?: SignerServerOptions["binding"]): Promise<Record<string, unknown>> {
  // /health never reaches the signer, so an empty stand-in is enough here.
  const server = createSignerServer({
    signer: {} as EscrowAuthorizationSigner,
    ...(binding ? { binding } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return (await response.json()) as Record<string, unknown>;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("GET /health", () => {
  /*
   * Goal ids repeat across vaults, and the sweep tool refuses to act unless the
   * signer reads the vault it was pointed at. This is how it finds out.
   */
  it("reports the chain and vault the signer reads", async () => {
    const vault = "0x518B8701484ba99A38f60090cd4a2cc710d3522c";
    expect(await health({ chainId: 84532, vault })).toMatchObject({
      ok: true,
      service: "authorization-signer",
      chainId: 84532,
      vault,
    });
  });

  it("still answers without a binding", async () => {
    const body = await health();
    expect(body).toMatchObject({ ok: true });
    expect(body).not.toHaveProperty("vault");
  });
});

describe("a signer that failed to boot", () => {
  const failure = {
    stage: "key index rebuild",
    detail: "rofl-appd unreachable at /run/rofl-appd.sock: connect EACCES /run/rofl-appd.sock",
    hint: "the signer cannot open the enclave key daemon's socket.",
    since: "2026-10-09T12:05:00.000Z",
    attempts: 3,
  };

  async function request(path: string, method = "GET"): Promise<{ status: number; body: Record<string, unknown> }> {
    const server = createBootFailureServer(() => failure);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("says why on /health, with 503", async () => {
    const { status, body } = await request("/health");
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, state: "boot-failed", ...failure });
  });

  it("refuses every other route with the same reason", async () => {
    const { status, body } = await request("/payer", "POST");
    expect(status).toBe(503);
    expect(String(body["error"])).toContain("boot failed at key index rebuild");
  });
});
