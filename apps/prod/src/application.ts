import type { Logger } from "pino";

import type { ProdConfig } from "./config.js";
import {
  openDatabase,
  type DatabaseConnection,
  type ProdDatabase,
} from "./database.js";
import { createDiscordGateway, type DiscordGateway } from "./discord.js";
import { applyMigrations } from "./migrations.js";

export type RunningProd = Readonly<{
  stop: (reason?: string) => Promise<void>;
}>;

type ApplicationDependencies = Readonly<{
  logger: Logger;
  gateway?: DiscordGateway;
  openDatabase?: (databaseUrl: string) => DatabaseConnection;
  migrate?: (
    database: ProdDatabase,
    onHistoryApplied: (owner: string) => void,
  ) => Promise<void>;
}>;

const defaultMigrate: NonNullable<ApplicationDependencies["migrate"]> = (
  database,
  onHistoryApplied,
) => applyMigrations(database, undefined, onHistoryApplied);

export const startProd = async (
  config: ProdConfig,
  dependencies: ApplicationDependencies,
): Promise<RunningProd> => {
  const logger = dependencies.logger;
  const gateway = dependencies.gateway ?? createDiscordGateway();
  const connection = (dependencies.openDatabase ?? openDatabase)(config.databaseUrl);
  const migrate = dependencies.migrate ?? defaultMigrate;

  try {
    await migrate(connection.database, (owner) => {
      logger.debug({ migrationOwner: owner }, "migration history applied");
    });

    const identity = await gateway.connect(config.discordToken);
    logger.info(
      {
        discordUserId: identity.userId,
        discordUserTag: identity.tag,
        developmentGuildId: config.discordDevGuildId,
        actionCount: 0,
      },
      "Prod ready",
    );
  } catch (error) {
    try {
      await gateway.close();
    } catch (closeError) {
      logger.error({ err: closeError }, "failed to close Discord after startup failure");
    } finally {
      connection.close();
    }
    throw error;
  }

  let stopped = false;
  return Object.freeze({
    stop: async (reason = "requested") => {
      if (stopped) {
        return;
      }
      stopped = true;

      logger.info({ reason }, "Prod stopping");
      try {
        await gateway.close();
      } finally {
        connection.close();
      }
      logger.info("Prod stopped");
    },
  });
};
