import { afterEach, describe, expect, it } from "vitest";

import { bindHost, exposedWithoutToken, serviceToken } from "./guard.js";

const TOUCHED = ["BIND_HOST", "SERVICE_TOKEN"];

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

describe("bindHost", () => {
  it("defaults to loopback", () => {
    expect(bindHost()).toBe("127.0.0.1");
  });
});

describe("serviceToken", () => {
  it("treats unset and empty alike", () => {
    expect(serviceToken()).toBeUndefined();
    process.env["SERVICE_TOKEN"] = "";
    expect(serviceToken()).toBeUndefined();
  });
});

/*
 * The predicate a disclosure route asks before serving. Both halves of the
 * guard are opt-in, so the question "is this process reachable by a stranger
 * with nothing to present" has to be asked explicitly — it is not implied by
 * either setting alone.
 */
describe("exposedWithoutToken", () => {
  it("is false on the default loopback bind", () => {
    expect(exposedWithoutToken()).toBe(false);
  });

  it.each(["127.0.0.1", "localhost", "::1", "[::1]"])(
    "is false on the loopback spelling %s",
    (host) => {
      process.env["BIND_HOST"] = host;
      expect(exposedWithoutToken()).toBe(false);
    },
  );

  /*
   * A specific private address counts as exposed. The question is whether
   * somebody else can reach the socket, not whether the address is routable on
   * the public internet — a laptop on conference wifi is the case this exists
   * for.
   */
  it.each(["0.0.0.0", "10.0.0.5", "192.168.1.20", "::"])(
    "is true on %s with no token",
    (host) => {
      process.env["BIND_HOST"] = host;
      expect(exposedWithoutToken()).toBe(true);
    },
  );

  it("is false once a token is configured, however it is bound", () => {
    process.env["BIND_HOST"] = "0.0.0.0";
    process.env["SERVICE_TOKEN"] = "s3cret";
    expect(exposedWithoutToken()).toBe(false);
  });

  /*
   * An empty token is not a token. `serviceToken()` already collapses the two,
   * and this pins that the collapse reaches here: `SERVICE_TOKEN=` in a .env
   * file is the shape an operator produces by deleting a value, and reading it
   * as "configured" would silently unseal the route.
   */
  it("treats an empty token as no token", () => {
    process.env["BIND_HOST"] = "0.0.0.0";
    process.env["SERVICE_TOKEN"] = "";
    expect(exposedWithoutToken()).toBe(true);
  });

  /*
   * `localhost.evil.com` resolves wherever its owner points it. The origin
   * check has the same hazard and parses with `URL` to avoid it; this one is a
   * bare host, so the comparison is exact rather than a prefix.
   */
  it("does not accept a hostname that merely starts with a loopback name", () => {
    process.env["BIND_HOST"] = "localhost.evil.com";
    expect(exposedWithoutToken()).toBe(true);
  });
});
