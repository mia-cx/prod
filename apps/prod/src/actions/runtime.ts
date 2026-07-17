import type {
  ApplicationCommandData,
  Interaction,
  Message,
} from "discord.js";
import type { Logger } from "pino";
import {
  createDiscordUserSubject,
  type AuthorizationContext,
  type AuthorizationService,
  type DiscordMemberLike,
  type UserAuthorizationSubject,
} from "@protocord/permissions";
import {
  createActionRegistry,
  createDiscordInteractionProviders,
  createTextCommandProvider,
  dispatchTextCommand,
  getDiscordCommandRegistration,
  handleDiscordInteraction,
  registerDiscordCommands,
  type DispatchResult,
  type DiscordInteractionHandleResult,
} from "protocord";

import type { DiscordActionSurface } from "../discord.js";
import type { GuildSettingsStore } from "../guild-settings.js";
import type { ExecuteGuildOperation } from "../guild-operation.js";
import type { PermissionAdministrationService } from "../permission-administration.js";
import type { SupportHubDiscord } from "../support-hub.js";
import type { TicketProvisioningService } from "../ticket-provisioning.js";
import { createTicketAction } from "./create-ticket.js";
import { pingAction } from "./ping.js";
import { createGuildSetupSettingsConsumer } from "./settings.js";

export type ProdActionContext = Readonly<{
  logger: Logger;
  isApplicationOperator: (userId: string) => boolean;
  createUserAuthorizationSubject: (
    member: DiscordMemberLike,
    context: AuthorizationContext,
  ) => UserAuthorizationSubject;
  replyToTextCommand?: (
    content: string,
    deleteAfterMs?: number,
  ) => Promise<void>;
}>;

export type ProdActionRuntime = DiscordActionSurface &
  Readonly<{
    actionCount: number;
    commands: readonly ApplicationCommandData[];
    isApplicationOperator: (userId: string) => boolean;
    createUserAuthorizationSubject: ProdActionContext["createUserAuthorizationSubject"];
    setApplicationOperatorUserIds: (userIds: readonly string[]) => void;
  }>;

export type ProdActionRuntimeOptions = Readonly<{
  textCommandPrefix: string;
  guildSettingsStore: GuildSettingsStore;
  supportHubDiscord: SupportHubDiscord;
  ticketProvisioningService: TicketProvisioningService;
  executeGuildOperation?: ExecuteGuildOperation;
  permissionAdministration?: PermissionAdministrationService;
  permissionAuthorization?: AuthorizationService;
}>;

export const createProdActionRuntime = (
  logger: Logger,
  options: ProdActionRuntimeOptions,
): ProdActionRuntime => {
  const applicationOperatorUserIds = new Set<string>();
  const isApplicationOperator = (userId: string): boolean =>
    applicationOperatorUserIds.has(userId);
  const createUserAuthorizationSubject: ProdActionContext["createUserAuthorizationSubject"] =
    (member, context) =>
      createDiscordUserSubject(member, context, { isApplicationOperator });
  const context: ProdActionContext = {
    logger,
    isApplicationOperator,
    createUserAuthorizationSubject,
  };
  if (
    (options.permissionAdministration === undefined) !==
    (options.permissionAuthorization === undefined)
  ) {
    throw new TypeError(
      "Permission settings require both administration and authorization services",
    );
  }
  const settings = createGuildSetupSettingsConsumer(
    logger,
    isApplicationOperator,
    options.guildSettingsStore,
    options.supportHubDiscord,
    options.ticketProvisioningService,
    options.executeGuildOperation,
    options.permissionAdministration === undefined ||
      options.permissionAuthorization === undefined
      ? undefined
      : {
          administration: options.permissionAdministration,
          authorization: options.permissionAuthorization,
          createUserAuthorizationSubject,
        },
  );
  const textProvider = createTextCommandProvider<ProdActionContext>({
    prefix: options.textCommandPrefix,
    present: async (_trigger, _message, outcome, presentationContext) => {
      await presentationContext.replyToTextCommand?.(
        textCommandOutcomeContent(outcome),
      );
    },
  });
  const registry = createActionRegistry<ProdActionContext>({
    providers: [
      ...createDiscordInteractionProviders<ProdActionContext>(),
      textProvider,
    ],
  });
  registry.registerAction(pingAction);
  registry.registerAction(
    createTicketAction(options.ticketProvisioningService),
  );
  registry.registerAction(settings.action);

  const handleMessage = textProvider.prefix
    ? async (message: Message): Promise<boolean> => {
        const dispatched = await dispatchTextCommand({
          registry,
          provider: textProvider,
          message,
          context: {
            logger,
            isApplicationOperator,
            createUserAuthorizationSubject,
            replyToTextCommand: async (content, deleteAfterMs) => {
              const response = await message.reply({
                content,
                allowedMentions: { parse: [], repliedUser: false },
              });
              if (deleteAfterMs !== undefined) {
                const timer = setTimeout(() => {
                  void response
                    .delete()
                    .catch((error: unknown) =>
                      logger.error(
                        { err: error },
                        "failed to delete ticket text-command reply",
                      ),
                    );
                }, deleteAfterMs);
                timer.unref();
              }
            },
          },
        });
        if (dispatched.consumed) {
          logActionDispatchResult(logger, dispatched.result);
        }
        return dispatched.consumed;
      }
    : undefined;

  return Object.freeze({
    actionCount: registry.actions.length,
    commands: getDiscordCommandRegistration(registry),
    isApplicationOperator,
    createUserAuthorizationSubject,
    setApplicationOperatorUserIds: (userIds) => {
      applicationOperatorUserIds.clear();
      for (const userId of userIds) applicationOperatorUserIds.add(userId);
    },
    refreshCommands: (client) => registerDiscordCommands(client, registry),
    reconcile: async (client) => {
      const reconciliationFailures: unknown[] = [];
      for (const guild of client.guilds.cache.values()) {
        try {
          await settings.reconcile(guild);
        } catch (error) {
          reconciliationFailures.push(error);
        }
      }
      const discovery =
        await options.ticketProvisioningService.discoverRecoveryThreads(
          async (guildId) => client.guilds.fetch(guildId),
        );
      if (discovery.failed > 0) {
        reconciliationFailures.push(
          new Error(
            `Prod could not discover ${String(discovery.failed)} interrupted ticket threads before recovery`,
          ),
        );
      }
      if (reconciliationFailures.length > 0) {
        throw new AggregateError(
          reconciliationFailures,
          "Prod could not reconcile startup state",
        );
      }
      const result = await options.ticketProvisioningService.recover(
        async (guildId) => client.guilds.fetch(guildId),
      );
      const details = {
        recoveredTicketCount: result.recovered,
        failedTicketCount: result.failed,
      };
      if (result.failed > 0) {
        logger.error(
          details,
          "ticket provisioning reconciliation completed with failures",
        );
      } else {
        logger.info(details, "ticket provisioning reconciliation completed");
      }
    },
    handleInteraction: async (interaction: Interaction) => {
      const settingsResult = await settings.handle(interaction);
      if (settingsResult.matched) {
        return;
      }
      const handled = await handleDiscordInteraction(
        registry,
        interaction,
        context,
      );
      logProdActionResult(logger, handled);
    },
    ...(handleMessage ? { handleMessage } : {}),
    handleError: (error: unknown) => {
      logger.error({ err: error }, "Discord action dispatch failed");
    },
  });
};

export const logProdActionResult = (
  logger: Logger,
  handled: DiscordInteractionHandleResult,
): void => {
  if (!handled.handled || handled.type !== "command") {
    return;
  }

  logActionDispatchResult(logger, handled.result);
};

export const logActionDispatchResult = (
  logger: Logger,
  result: Extract<DispatchResult, { matched: true }>,
): void => {
  const details = {
    action: result.actionName,
    trigger: result.triggerName,
  };
  if (result.outcome.status === "failed") {
    logger.error(
      { ...details, err: result.outcome.error },
      "action lifecycle failed",
    );
  }
  if (result.presentationError !== undefined) {
    logger.error(
      { ...details, err: result.presentationError },
      "failed to present action result",
    );
  }
};

const textCommandOutcomeContent = (
  outcome: Extract<DispatchResult, { matched: true }>["outcome"],
): string => {
  switch (outcome.status) {
    case "executed":
      return typeof outcome.output === "string"
        ? outcome.output
        : (JSON.stringify(outcome.output) ?? String(outcome.output));
    case "unavailable":
      return "That action is currently unavailable.";
    case "unauthorized":
      return "You do not have permission to run that action.";
    case "failed":
      return "Something went wrong while running that action.";
  }
};
