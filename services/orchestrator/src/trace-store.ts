/**
 * Where completed traces live.
 *
 * They used to live in a `Map` on the server closure, which had two problems
 * that only show up at the wrong moment. A restart lost every trace, so
 * `GET /traces/:goalId` started 404ing for runs that had demonstrably happened
 * — and the trace is the artifact that makes a run checkable by someone who was
 * not in the room, so losing it loses the product's evidence. And nothing ever
 * evicted, so a long-lived process accumulated every trace it had ever built.
 *
 * This is deliberately a directory of JSON files and not a database. A trace is
 * append-only, addressed by one key, and read far less often than it is
 * written; the filesystem is a perfectly good store for that, and it is one
 * fewer service to stand up before a demo.
 *
 * ## Ordering
 *
 * The write happens before the map insert, so a trace that is readable in
 * memory is always already durable. The reverse order would leave a window
 * where a crash loses a trace the process had already served.
 *
 * The memory cache is a bounded LRU in front of the disk, so repeat reads of a
 * hot goal do not hit the filesystem and a cold one still resolves.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { Trace } from "@ntux402/trace";

/** Traces held in memory. Beyond this, reads fall through to disk. */
const MAX_CACHED = 64;

/** Rejects anything that is not a plain decimal id, since this becomes a path. */
const GOAL_ID = /^[0-9]{1,32}$/;

export class TraceStore {
  readonly #dir: string;
  readonly #cache = new Map<string, Trace>();

  constructor(dir: string) {
    this.#dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  #pathFor(goalId: string): string {
    return join(this.#dir, `goal-${goalId}.json`);
  }

  /**
   * Persists, then caches.
   *
   * Written to a temporary name and renamed into place: `rename` is atomic
   * within a filesystem, so a reader can never observe a half-written trace,
   * and a crash mid-write leaves the previous file intact rather than a
   * truncated one.
   */
  save(goalId: string, trace: Trace): void {
    if (!GOAL_ID.test(goalId)) return;

    const target = this.#pathFor(goalId);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(trace, bigints, 2), "utf8");
    renameSync(temp, target);

    this.#cache.delete(goalId);
    this.#cache.set(goalId, trace);
    if (this.#cache.size > MAX_CACHED) {
      // Map preserves insertion order, so the first key is the least recently
      // written or read — a serviceable LRU without a second structure.
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
  }

  get(goalId: string): Trace | undefined {
    if (!GOAL_ID.test(goalId)) return undefined;

    const cached = this.#cache.get(goalId);
    if (cached !== undefined) {
      // Refresh recency.
      this.#cache.delete(goalId);
      this.#cache.set(goalId, cached);
      return cached;
    }

    const path = this.#pathFor(goalId);
    if (!existsSync(path)) return undefined;
    try {
      const trace = JSON.parse(readFileSync(path, "utf8")) as Trace;
      this.#cache.set(goalId, trace);
      return trace;
    } catch {
      // A corrupt file is a missing trace, not a crashed request.
      return undefined;
    }
  }
}

/** `bigint` has no JSON representation; the trace carries several. */
function bigints(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
