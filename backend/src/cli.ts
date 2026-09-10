import { startServer } from "./index.js";
import { log } from "./logger.js";

// Standalone entry — `npm start` / `tsx watch src/cli.ts`. Not used when embedded in Electron.
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
