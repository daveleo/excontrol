import { loadConfig, getConfig } from "./config.js";
import { log } from "./logger.js";
import { startDevices, stopDevices } from "./core/registry.js";
import { startPowerMonitor } from "./core/power.js";
import { startScheduler } from "./core/schedule.js";
import { buildHttp } from "./api/http.js";
import { attachWs } from "./api/ws.js";
import { registerHttpRestarter } from "./core/httpControl.js";
import { BRAND } from "@excontrol/shared";
import type { FastifyInstance } from "fastify";

// Re-exported so the Electron main process can wire itself into the Settings panel's
// "start when Windows starts" toggle and "check for updates now" button, without either
// side needing to know the other's internals.
export { getConfig } from "./config.js";
export { registerAutoStartHandler } from "./core/autoStartControl.js";
export { registerUpdateChecker } from "./core/updateControl.js";

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  stop: () => Promise<void>;
}

/** Boot the whole backend. Electron's main process calls this; so does the CLI (cli.ts). */
export async function startServer(): Promise<RunningServer> {
  const cfg = loadConfig();
  log.info({ devices: cfg.devices.map((d) => d.id), configured: cfg.devices.length > 0 }, `${BRAND.name} starting`);

  await startDevices(cfg);
  startPowerMonitor();
  const stopScheduler = startScheduler();

  let app: FastifyInstance = await buildHttp();
  let detachWs: () => void = () => {};
  let port = cfg.app.httpPort;

  async function listen(): Promise<void> {
    const c = getConfig();
    await app.listen({ port: c.app.httpPort, host: c.app.bind });
    detachWs = attachWs(app.server);
    port = c.app.httpPort;
    log.info({ url: `http://127.0.0.1:${port}` }, "listening");
  }
  await listen();

  // Lets the setup-save route rebind the HTTP layer after a port/bind change, without
  // giving http.ts a reference to this closure's state directly.
  registerHttpRestarter(async () => {
    const prevPort = port;
    detachWs();
    await app.close();
    app = await buildHttp();
    try {
      await listen();
    } catch (e) {
      log.error({ err: e, attempted: getConfig().app.httpPort }, "failed to bind the new port — reverting");
      const c = getConfig();
      const { saveConfig } = await import("./config.js");
      saveConfig({ ...c, app: { ...c.app, httpPort: prevPort } });
      app = await buildHttp();
      await listen();
      throw e;
    }
    return { url: `http://127.0.0.1:${port}`, port };
  });

  return {
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get port() {
      return port;
    },
    stop: async () => {
      registerHttpRestarter(null);
      stopScheduler();
      detachWs();
      await app.close();
      await stopDevices();
    },
  };
}
