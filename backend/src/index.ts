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

/** Boot the whole backend. Electron's main process calls this; so does the CLI (cli.ts). */
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
