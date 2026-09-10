import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { startDevices, stopDevices } from "./core/registry.js";
import { startPowerMonitor } from "./core/power.js";
import { startScheduler } from "./core/schedule.js";
import { buildHttp } from "./api/http.js";
import { attachWs } from "./api/ws.js";
import { BRAND } from "@excontrol/shared";

export interface RunningServer {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

/** Boot the whole backend. Electron calls this in its main process; the CLI calls it below. */
export async function startServer(): Promise<RunningServer> {
  const cfg = loadConfig();
  log.info({ devices: cfg.devices.map((d) => d.id), configured: cfg.devices.length > 0 }, `${BRAND.name} starting`);

  await startDevices(cfg);
  startPowerMonitor();
  const stopScheduler = startScheduler();

  const app = await buildHttp();
  await app.listen({ port: cfg.app.httpPort, host: cfg.app.bind });
  const detachWs = attachWs(app.server);
  const url = `http://127.0.0.1:${cfg.app.httpPort}`;
  log.info({ url }, "listening");

  return {
    url,
    port: cfg.app.httpPort,
    stop: async () => {
      stopScheduler();
      detachWs();
      await app.close();
      await stopDevices();
    },
  };
}

// CLI entry (dev / `npm start`) — not used when embedded in Electron.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startServer()
    .then((srv) => {
      const shutdown = async (sig: string) => {
        log.info({ sig }, "shutting down");
        await srv.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
    })
    .catch((e) => {
      log.error({ err: e }, "fatal");
      process.exit(1);
    });
}
