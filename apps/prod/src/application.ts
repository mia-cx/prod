import type { Logger } from "pino";

import type { ProdConfig } from "./config.js";
import { createProdActionRuntime } from "./actions/runtime.js";
import {
  openDatabase,
  type DatabaseConnection,
  type ProdDatabase,
} from "./database.js";
import { createDiscordGateway, type DiscordGateway } from "./discord.js";
import { createSqliteGuildSettingsStore } from "./guild-settings.js";
import { createGuildOperationExecutor } from "./guild-operation.js";
import { applyMigrations } from "./migrations.js";
import { createSupportHubDiscord } from "./support-hub.js";
import {
  createTicketProvisioningDiscord,
  createTicketProvisioningService,
} from "./ticket-provisioning.js";
import { createSqliteTicketStore } from "./tickets.js";

export type RunningProd = Readonly<{
  stop: (reason?: string) => Promise<void>;
}>;

export type StartProdOptions = Readonly<{
  signal?: AbortSignal;
}>;

type ApplicationDependencies = Readonly<{
  logger: Logger;
  gateway?: DiscordGateway;
  openDatabase?: (databaseUrl: string) => DatabaseConnection;
  migrate?: (
    database: ProdDatabase,
    onHistoryApplied: (owner: string) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}>;

const defaultMigrate: NonNullable<ApplicationDependencies["migrate"]> = (
  database,
  onHistoryApplied,
  signal,
) => {
  signal.throwIfAborted();
  return applyMigrations(database, undefined, onHistoryApplied).then(() => {
    signal.throwIfAborted();
  });
};

export const startProd = async (
  config: ProdConfig,
  dependencies: ApplicationDependencies,
  options: StartProdOptions = {},
): Promise<RunningProd> => {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();

  const logger = dependencies.logger;
  const connection = (dependencies.openDatabase ?? openDatabase)(
    config.databaseUrl,
  );
  const migrate = dependencies.migrate ?? defaultMigrate;
  let gateway: DiscordGateway | undefined;

  try {
    const guildSettingsStore = createSqliteGuildSettingsStore(
      connection.database,
    );
    const executeGuildOperation = createGuildOperationExecutor();
    const ticketProvisioningService = createTicketProvisioningService(
      guildSettingsStore,
      createSqliteTicketStore(connection.database),
      createTicketProvisioningDiscord(),
      { executeGuildOperation },
    );
    const actions = createProdActionRuntime(logger, {
      textCommandPrefix: config.textCommandPrefix,
      guildSettingsStore,
      supportHubDiscord: createSupportHubDiscord(),
      ticketProvisioningService,
      executeGuildOperation,
    });
    gateway =
      dependencies.gateway ??
      createDiscordGateway({
        actions,
        configuredApplicationOperatorUserIds: config.botOperatorUserIds,
      });
    const runningGateway = gateway;

    await migrate(
      connection.database,
      (owner) => {
        logger.debug({ migrationOwner: owner }, "migration history applied");
      },
      signal,
    );
    signal.throwIfAborted();

    const identity = await runningGateway.connect(config.discordToken, signal);
    signal.throwIfAborted();
    logger.info(
      {
        discordUserId: identity.userId,
        discordUserTag: identity.tag,
        applicationOperatorCount: identity.applicationOperatorUserIds.length,
        actionCount: actions.actionCount,
      },
      "Prod ready",
    );

    let stopped = false;
    return Object.freeze({
      stop: async (reason = "requested") => {
        if (stopped) {
          return;
        }
        stopped = true;

        logger.info({ reason }, "Prod stopping");
        try {
          await runningGateway.close();
        } finally {
          connection.close();
        }
        logger.info("Prod stopped");
      },
    });
  } catch (error) {
    if (gateway !== undefined) {
      try {
        await gateway.close();
      } catch (closeError) {
        logger.error(
          { err: closeError },
          "failed to close Discord after startup failure",
        );
      }
    }
    try {
      connection.close();
    } catch (closeError) {
      logger.error(
        { err: closeError },
        "failed to close database after startup failure",
      );
    }
    throw error;
  }
};
