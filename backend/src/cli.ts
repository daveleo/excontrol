import { startServer } from "./index.js";
import { log } from "./logger.js";

/** Hard cap on a graceful stop — app.close() waits on open browser keep-alive/WebSocket
 *  connections, so without this a connected dashboard can hold shutdown forever (and a
 *  systemd stop would sit out its full timeout before SIGKILL). */
const SHUTDOWN_TIMEOUT_MS = 5000;

// Standalone entry — `npm start` / `tsx watch src/cli.ts` / the Pi systemd service.
// Not used when embedded in Electron.
startServer()
  .then((srv) => {
    let stopping = false;
    const shutdown = async (sig: string) => {
      if (stopping) {
        // Second Ctrl+C: the operator means it.
        log.warn({ sig }, "forced exit");
        process.exit(1);
      }
      stopping = true;
      log.info({ sig }, "shutting down");
      setTimeout(() => {
        log.warn({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "graceful stop timed out — exiting");
        process.exit(0);
      }, SHUTDOWN_TIMEOUT_MS).unref();
      try {
        await srv.stop();
      } catch (e) {
        log.error({ err: e }, "error during shutdown");
      }
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  })
  .catch((e) => {
    log.error({ err: e }, "fatal");
    process.exit(1);
  });
