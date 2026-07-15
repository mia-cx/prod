import type { Logger } from "pino";

import { startProd, type RunningProd } from "./application.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

let logger: Logger = createLogger({ level: "info" });

const run = async (): Promise<void> => {
  const startup = new AbortController();
  let application: RunningProd | undefined;
  let stopping = false;

  const stop = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    startup.abort(new DOMException(`Prod received ${signal}`, "AbortError"));

    if (application === undefined) {
      return;
    }

    try {
      await application.stop(signal);
    } catch (error) {
      logger.error({ err: error }, "Prod shutdown failed");
      process.exitCode = 1;
    }
  };

  const handleSigint = () => void stop("SIGINT");
  const handleSigterm = () => void stop("SIGTERM");
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  const config = loadConfig(process.env);
  logger = createLogger({
    level: config.logLevel,
    secrets: [config.discordToken],
  });

  try {
    application = await startProd(config, { logger }, { signal: startup.signal });
  } catch (error) {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    if (startup.signal.aborted && error === startup.signal.reason) {
      return;
    }
    throw error;
  }
};

run().catch((error: unknown) => {
  logger.fatal({ err: error }, "Prod failed to start");
  process.exitCode = 1;
});
