/**
 * Service logging.
 *
 * Every service wrote `console.log(\`[name] ...\`)`, which is fine to read over
 * your own shoulder and close to useless anywhere else: no level, no timestamp,
 * nothing a log pipeline can filter on, and no way to tell a warning from a
 * routine line without reading the sentence.
 *
 * Two formats, one switch:
 *
 *   LOG_FORMAT=pretty  (default)  [signer] listening on ...
 *   LOG_FORMAT=json               {"t":"…","level":"info","svc":"signer","msg":"…"}
 *
 * Pretty stays the default deliberately. The thing this project does most is
 * get run in a terminal in front of people, and JSON lines are worse for that
 * than the prefix they replace. JSON is what you turn on when something is
 * collecting the output.
 *
 * ## Levels go to the right stream
 *
 * `warn` and `error` write to stderr, `info` and `debug` to stdout. The dev
 * runner interleaves both, but anything that redirects them separately — a
 * container, a systemd unit, a CI job — then gets the split for free.
 *
 * Structured fields are a second argument rather than interpolation, so a value
 * stays a value in JSON mode instead of being flattened into prose.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A logger for a sub-area, e.g. `http`, carrying the same service name. */
  child(area: string): Logger;
}

function minLevel(): number {
  const configured = (process.env["LOG_LEVEL"] ?? "info").toLowerCase();
  return ORDER[configured as LogLevel] ?? ORDER.info;
}

function useJson(): boolean {
  return (process.env["LOG_FORMAT"] ?? "pretty").toLowerCase() === "json";
}

/**
 * `bigint` has no JSON representation and appears throughout the chain types,
 * so it is stringified rather than allowed to throw inside a log call. A logger
 * that can crash the thing it is observing is worse than no logger.
 */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function createLogger(service: string, area?: string): Logger {
  const label = area === undefined ? service : `${service}:${area}`;

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < minLevel()) return;
    const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;

    if (useJson()) {
      let line: string;
      try {
        line = JSON.stringify(
          { t: new Date().toISOString(), level, svc: label, msg: message, ...fields },
          replacer,
        );
      } catch {
        // An unserialisable field must not lose the message.
        line = JSON.stringify({ t: new Date().toISOString(), level, svc: label, msg: message });
      }
      stream.write(line + "\n");
      return;
    }

    const marker = level === "info" ? "" : `${level.toUpperCase()} `;
    const extra =
      fields === undefined || Object.keys(fields).length === 0
        ? ""
        : "  " +
          Object.entries(fields)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v, replacer)}`)
            .join(" ");
    stream.write(`[${label}] ${marker}${message}${extra}\n`);
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (childArea) => createLogger(service, area ? `${area}:${childArea}` : childArea),
  };
}
