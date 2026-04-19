/**
 * Tiny structured-ish logger for the MVP. Replace with pino/winston when needed.
 */

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [${scope}] ${msg}`;
  if (meta !== undefined) {
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](line, meta);
  } else {
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](line);
  }
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, x) => emit("debug", scope, m, x),
    info: (m, x) => emit("info", scope, m, x),
    warn: (m, x) => emit("warn", scope, m, x),
    error: (m, x) => emit("error", scope, m, x),
  };
}
