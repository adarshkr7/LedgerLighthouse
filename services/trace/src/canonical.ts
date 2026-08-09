/**
 * Canonical serialisation. Everything the trace hashes goes through here.
 *
 * A verifier that cannot reproduce the exact bytes cannot reproduce the hash,
 * so "canonical" is doing real work: object keys are sorted, `bigint` becomes a
 * decimal string, `undefined` members are dropped, and there is no incidental
 * whitespace. `JSON.stringify` alone guarantees none of that — it preserves
 * insertion order, which means two structurally identical traces built by
 * different code paths would hash differently.
 */

import { keccak256, toHex, type Hex } from "viem";

export type Canonical =
  | string
  | number
  | boolean
  | null
  | readonly Canonical[]
  | { readonly [key: string]: Canonical };

/** Normalises to a JSON-safe shape. Rejects what cannot be canonicalised. */
export function canonicalize(value: unknown, path = "$"): Canonical {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`${path}: ${value} is not finite`);
      return value;
    case "bigint":
      return value.toString();
    case "undefined":
      throw new Error(`${path}: undefined cannot be canonicalised (drop the key instead)`);
    case "object":
      break;
    default:
      throw new Error(`${path}: ${typeof value} cannot be canonicalised`);
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => canonicalize(item, `${path}[${i}]`));
  }

  if (value instanceof Uint8Array) return toHex(value);

  const source = value as Record<string, unknown>;
  const out: Record<string, Canonical> = {};
  // Sorted, so insertion order cannot change the bytes.
  for (const key of Object.keys(source).sort()) {
    const member = source[key];
    if (member === undefined) continue; // absent and explicitly-undefined are the same thing
    out[key] = canonicalize(member, `${path}.${key}`);
  }
  return out;
}

/** Deterministic JSON. Same input, same bytes, on any machine. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashPayload(value: unknown): Hex {
  return keccak256(toHex(canonicalJson(value)));
}
