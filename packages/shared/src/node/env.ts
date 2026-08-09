/**
 * Node-only configuration helpers, kept on a `@ntux402/shared/node` subpath so
 * the browser bundle never pulls `node:fs` in through the package root.
 *
 * The `.env` reader is deliberately dependency-free: no interpolation, no shell
 * expansion, no `export` handling. A config loader with surprises in it is a
 * config loader that eventually points a signer at the wrong chain.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Address } from "../x402/protocol.js";

/** Walks up from `startDir` for the nearest directory containing `pnpm-workspace.yaml`. */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

/**
 * Loads the repo-root `.env` into `process.env`. Existing environment variables
 * win — a value exported in the shell is a deliberate override, and silently
 * replacing it is how you spend an hour debugging the wrong key.
 */
export function loadDotEnv(path?: string): void {
  const file = path ?? join(findRepoRoot(), ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip an inline comment only when the value is unquoted.
    if (!/^["']/.test(value)) value = value.split(/\s+#/)[0]!.trim();
    value = value.replace(/^(["'])(.*)\1$/, "$2");
    if (value !== "" && process.env[key] === undefined) process.env[key] = value;
  }
}

export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in, or export it in the shell.`,
    );
  }
  return value;
}

export function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

export function requiredAddress(name: string): Address {
  const raw = required(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`${name} must be a 20-byte hex address, got ${JSON.stringify(raw)}`);
  }
  return raw as Address;
}

export function requiredHexKey(name: string): `0x${string}` {
  const raw = required(name);
  const withPrefix = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error(`${name} must be a 32-byte hex private key.`);
  }
  return withPrefix as `0x${string}`;
}
