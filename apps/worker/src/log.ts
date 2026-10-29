export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** One JSON line per record. Callers must never pass tokens, secrets or env values. */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (l) => process.stdout.write(l + "\n"),
): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields }));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const silentLogger: Logger = createLogger("error", () => {});

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
