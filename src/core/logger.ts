export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, ...meta: unknown[]): void;
  info(msg: string, ...meta: unknown[]): void;
  warn(msg: string, ...meta: unknown[]): void;
  error(msg: string, ...meta: unknown[]): void;
  /** A logger whose lines are tagged with `scope` (e.g. a tab key). */
  child(scope: string): Logger;
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    const desc = (value as { description?: string }).description;
    return desc ? `${value.name}: ${desc}` : value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One line per event on stdout/stderr; journald adds its own timestamps in production. */
export function createLogger(level: LogLevel = "info", scope?: string): Logger {
  const min = RANK[level];
  const emit = (lvl: LogLevel, msg: string, meta: unknown[]) => {
    if (RANK[lvl] < min) return;
    const line = `${lvl.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ""}${msg}${meta.length ? " " + meta.map(describe).join(" ") : ""}`;
    (lvl === "error" || lvl === "warn" ? console.error : console.log)(line);
  };
  return {
    debug: (msg, ...meta) => emit("debug", msg, meta),
    info: (msg, ...meta) => emit("info", msg, meta),
    warn: (msg, ...meta) => emit("warn", msg, meta),
    error: (msg, ...meta) => emit("error", msg, meta),
    child: (child) => createLogger(level, scope ? `${scope}/${child}` : child),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};
