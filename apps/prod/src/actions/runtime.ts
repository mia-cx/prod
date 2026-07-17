import {
  ChannelType,
  type AnyThreadChannel,
  type ApplicationCommandData,
  type Guild,
  type Interaction,
  type Message,
} from "discord.js";
import type { Logger } from "pino";
import {
  createDiscordUserSubject,
  type AuthorizationContext,
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
import {
  deletePublicSupportHubThread,
  type SupportHubDiscord,
} from "../support-hub.js";
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
  hubSafetyRetryMs?: number;
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
  const settings = createGuildSetupSettingsConsumer(
    logger,
    isApplicationOperator,
    options.guildSettingsStore,
    options.supportHubDiscord,
    options.ticketProvisioningService,
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

  const scheduledHubSafetyRetries = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const reconcileHubSafety = async (
    guild: Guild,
    hubChannelId: string,
  ): Promise<void> => {
    await options.supportHubDiscord.deletePublicThreads(guild, hubChannelId);
    const validation = await options.supportHubDiscord.validateHub(
      guild,
      hubChannelId,
    );
    if (!validation.valid) {
      throw new Error(validation.issues.join(" "));
    }
    await options.ticketProvisioningService.resumeHubAccess(
      guild,
      hubChannelId,
    );
  };
  const reconcileScheduledHubSafety = async (
    guild: Guild,
    hubChannelId: string,
  ): Promise<void> => {
    const state = await options.guildSettingsStore.get(guild.id);
    if (state.hubChannelId !== hubChannelId) {
      await options.ticketProvisioningService.suspendHubAccess(
        guild,
        hubChannelId,
      );
      return;
    }
    await reconcileHubSafety(guild, hubChannelId);
  };
  const suspendHubSafety = async (
    guild: Guild,
    hubChannelId: string,
    error: unknown,
  ): Promise<unknown> => {
    try {
      await options.ticketProvisioningService.suspendHubAccess(
        guild,
        hubChannelId,
      );
      return error;
    } catch (suspensionError) {
      return new AggregateError(
        [error, suspensionError],
        "Failed to make the support hub safe and suspend reporter access",
      );
    }
  };
  const scheduleHubSafetyRetry = (guild: Guild, hubChannelId: string): void => {
    const key = `${guild.id}:${hubChannelId}`;
    if (scheduledHubSafetyRetries.has(key)) return;
    const timer = setTimeout(() => {
      scheduledHubSafetyRetries.delete(key);
      void reconcileScheduledHubSafety(guild, hubChannelId).catch(
        async (error) => {
          const retryError = await suspendHubSafety(guild, hubChannelId, error);
          logger.error(
            { err: retryError, guildId: guild.id, hubChannelId },
            "support hub remains unsafe; scheduling another reconciliation",
          );
          scheduleHubSafetyRetry(guild, hubChannelId);
        },
      );
    }, options.hubSafetyRetryMs ?? 30_000);
    timer.unref();
    scheduledHubSafetyRetries.set(key, timer);
  };

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
      const hubSafetyFailures: unknown[] = [];
      for (const guild of client.guilds.cache.values()) {
        let state: Awaited<ReturnType<typeof settings.reconcile>>;
        try {
          state = await settings.reconcile(guild);
        } catch (error) {
          hubSafetyFailures.push(error);
          continue;
        }
        if (state.hubChannelId !== undefined) {
          try {
            await reconcileHubSafety(guild, state.hubChannelId);
          } catch (error) {
            hubSafetyFailures.push(
              await suspendHubSafety(guild, state.hubChannelId, error),
            );
          }
        }
      }
      if (hubSafetyFailures.length > 0) {
        throw new AggregateError(
          hubSafetyFailures,
          "One or more support hubs could not be made safe during startup",
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
    handleThread: async (thread: AnyThreadChannel) => {
      if (thread.type !== ChannelType.PublicThread) return;
      const state = await options.guildSettingsStore.get(thread.guildId);
      if (state.hubChannelId !== thread.parentId) return;
      try {
        await deletePublicSupportHubThread(thread);
        await options.ticketProvisioningService.resumeHubAccess(
          thread.guild,
          state.hubChannelId,
        );
      } catch (error) {
        const unsafeError = await suspendHubSafety(
          thread.guild,
          state.hubChannelId,
          error,
        );
        scheduleHubSafetyRetry(thread.guild, state.hubChannelId);
        throw unsafeError;
      }
    },
    handleHubMessage: async (message: Message) => {
      if (message.guild === null) return;
      const state = await options.guildSettingsStore.get(message.guild.id);
      if (state.hubChannelId !== message.channelId) return;
      try {
        await reconcileHubSafety(message.guild, state.hubChannelId);
      } catch (error) {
        const unsafeError = await suspendHubSafety(
          message.guild,
          state.hubChannelId,
          error,
        );
        scheduleHubSafetyRetry(message.guild, state.hubChannelId);
        throw unsafeError;
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
