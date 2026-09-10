import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

/**
 * Tiny zero-dependency logger. levelled, JSON-ish lines to stdout, and (in production,
 * when EXCONTROL_DATA_DIR is set) also to a rotating-ish log file. No worker threads, so
 * it bundles cleanly into the Electron main process.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const min = () => ORDER[(process.env.LOG_LEVEL as Level) || "info"] ?? 20;
const pretty = () => process.env.NODE_ENV !== "production";

let file: WriteStream | null = null;
let fileTried = false;
function logFile(): WriteStream | null {
  if (fileTried) return file;
  fileTried = true;
  const dir = process.env.EXCONTROL_DATA_DIR;
  if (dir) {
    try {
      mkdirSync(join(dir, "logs"), { recursive: true });
      file = createWriteStream(join(dir, "logs", "excontrol.log"), { flags: "a" });
    } catch {
      /* stdout only */
    }
  }
  return file;
}

function emit(level: Level, ctx: Record<string, unknown> | undefined, msg: string): void {
  if (ORDER[level] < min()) return;
  const time = new Date().toISOString();
  if (pretty()) {
    const tag = { debug: "DBG", info: "INF", warn: "WRN", error: "ERR" }[level];
    const meta = ctx && Object.keys(ctx).length ? " " + safe(ctx) : "";
    process.stdout.write(`${time.slice(11, 19)} ${tag} ${msg}${meta}\n`);
  } else {
    const line = JSON.stringify({ time, level, msg, ...ctx }) + "\n";
    process.stdout.write(line);
    logFile()?.write(line);
  }
}

function safe(o: unknown): string {
  try {
    return JSON.stringify(o, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v));
  } catch {
    return String(o);
  }
}

export interface Logger {
  debug(ctx: Record<string, unknown> | string, msg?: string): void;
  info(ctx: Record<string, unknown> | string, msg?: string): void;
  warn(ctx: Record<string, unknown> | string, msg?: string): void;
  error(ctx: Record<string, unknown> | string, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

function make(bindings: Record<string, unknown>): Logger {
  const at = (level: Level) => (ctx: Record<string, unknown> | string, msg?: string) => {
    if (typeof ctx === "string") emit(level, bindings, ctx);
    else emit(level, { ...bindings, ...ctx }, msg ?? "");
  };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (b) => make({ ...bindings, ...b }),
  };
}

export const log: Logger = make({});
