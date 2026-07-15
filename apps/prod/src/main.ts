import type { Logger } from "pino";

import { startProd } from "./application.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

let logger: Logger = createLogger({ level: "info" });

const run = async (): Promise<void> => {
  const config = loadConfig(process.env);
  logger = createLogger({
    level: config.logLevel,
    secrets: [config.discordToken],
  });

  const application = await startProd(config, { logger });
  let stopping = false;

  const stop = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;

    try {
      await application.stop(signal);
    } catch (error) {
      logger.error({ err: error }, "Prod shutdown failed");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
};

run().catch((error: unknown) => {
  logger.fatal({ err: error }, "Prod failed to start");
  process.exitCode = 1;
});

