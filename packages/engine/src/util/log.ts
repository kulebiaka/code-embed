export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(m: string): void;
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function isLevel(v: string | undefined): v is LogLevel {
  return v !== undefined && Object.hasOwn(ORDER, v);
}

const envLevel = process.env.CODE_EMBED_LOG?.toLowerCase();
let currentLevel: LogLevel = isLevel(envLevel) ? envLevel : "info";
let currentSink: ((level: LogLevel, message: string) => void) | null = null;

function write(level: LogLevel, message: string): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  process.stderr.write(`[code-embed] ${level}: ${message}\n`);
  currentSink?.(level, message);
}

export const log: Logger = {
  debug: (m) => write("debug", m),
  info: (m) => write("info", m),
  warn: (m) => write("warn", m),
  error: (m) => write("error", m),
};

export function setLogSink(sink: ((level: LogLevel, message: string) => void) | null): void {
  currentSink = sink;
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}
