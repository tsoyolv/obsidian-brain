/**
 * Tiny structured-ish logger for the MVP. Replace with pino/winston when needed.
 *
 * Configuration via environment:
 *   - LOG_LEVEL  = "debug" | "info" | "warn" | "error"   (default: "info")
 *   - LOG_FORMAT = "pretty" | "json"                       (default: "pretty")
 */

export type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function envLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function envFormat(): "pretty" | "json" {
  return process.env.LOG_FORMAT === "json" ? "json" : "pretty";
}

const FORMAT = envFormat();

function shouldLog(level: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[envLevel()];
}

function emit(level: Level, scope: string, msg: string, meta?: unknown) {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const consoleFn =
    level === "debug" ? console.log : (console[level] as typeof console.log);

  if (FORMAT === "json") {
    const record: Record<string, unknown> = {
      ts,
      level,
      scope,
      msg,
    };
    if (meta !== undefined) record.meta = sanitizeMeta(meta);
    // eslint-disable-next-line no-console
    consoleFn(JSON.stringify(record));
    return;
  }

  const line = `[${ts}] [${level.toUpperCase()}] [${scope}] ${msg}`;
  if (meta !== undefined) {
    // eslint-disable-next-line no-console
    consoleFn(line, sanitizeMeta(meta));
  } else {
    // eslint-disable-next-line no-console
    consoleFn(line);
  }
}

/**
 * Trim obviously huge / circular fields so logs stay readable.
 * Truncates strings > 500 chars and Buffers (logs only their length).
 */
function sanitizeMeta(meta: unknown): unknown {
  if (meta == null || typeof meta !== "object") return meta;
  if (Buffer.isBuffer(meta)) return `<Buffer ${meta.length}B>`;
  if (Array.isArray(meta)) return meta.map((m) => sanitizeMeta(m));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 500) {
      out[k] = v.slice(0, 500) + `…(+${v.length - 500} chars)`;
    } else if (Buffer.isBuffer(v)) {
      out[k] = `<Buffer ${v.length}B>`;
    } else if (v && typeof v === "object") {
      out[k] = sanitizeMeta(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface Timer {
  /** Milliseconds elapsed since the timer was started. */
  ms(): number;
  /** Log an info-level message that includes `durationMs` automatically. */
  done(msg: string, meta?: Record<string, unknown>): void;
  /** Log a warn-level message that includes `durationMs` automatically. */
  fail(msg: string, meta?: Record<string, unknown>): void;
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  /**
   * Start a duration timer. Use {@link Timer.done} on success and
   * {@link Timer.fail} on failure to emit a log line tagged with `durationMs`.
   */
  time(label: string): Timer;
  /** Derive a sub-logger whose scope is `${parent}.${suffix}`. */
  child(suffix: string): Logger;
}

export function createLogger(scope: string): Logger {
  const log: Logger = {
    debug: (m, x) => emit("debug", scope, m, x),
    info: (m, x) => emit("info", scope, m, x),
    warn: (m, x) => emit("warn", scope, m, x),
    error: (m, x) => emit("error", scope, m, x),
    time: (label) => {
      const start = Date.now();
      const ms = () => Date.now() - start;
      return {
        ms,
        done(msg, meta) {
          emit("info", scope, `${label}: ${msg}`, { ...(meta ?? {}), durationMs: ms() });
        },
        fail(msg, meta) {
          emit("warn", scope, `${label}: ${msg}`, { ...(meta ?? {}), durationMs: ms() });
        },
      };
    },
    child: (suffix) => createLogger(`${scope}.${suffix}`),
  };
  return log;
}
