import { loadConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { createLogger } from "./logger.js";
import { applyMigrations } from "./migrations.js";

const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel, secrets: [config.discordToken] });
const connection = openDatabase(config.databaseUrl);

try {
  await applyMigrations(connection.database, undefined, (owner) => {
    logger.debug({ migrationOwner: owner }, "migration manifest applied");
  });
  logger.info("database migrations applied");
} finally {
  connection.close();
}

