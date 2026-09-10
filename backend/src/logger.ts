import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

const dataDir = process.env.EXCONTROL_DATA_DIR;
let logFile: string | undefined;
if (dataDir) {
  try {
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    logFile = join(dataDir, "logs", "excontrol.log");
  } catch {
    /* fall back to stdout only */
  }
}

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: {
    targets: [
      process.env.NODE_ENV === "production"
        ? { target: "pino/file", options: { destination: 1 } }
        : { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
      ...(logFile
        ? [{ target: "pino/file", options: { destination: logFile, mkdir: true } }]
        : []),
    ],
  },
});
