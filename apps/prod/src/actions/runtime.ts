import type { ApplicationCommandData, Interaction, Message } from "discord.js";
import type { Logger } from "pino";
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
import { pingAction } from "./ping.js";

export type ProdActionContext = Readonly<{
  logger: Logger;
  replyToTextCommand?: (content: string) => Promise<void>;
}>;

export type ProdActionRuntime = DiscordActionSurface &
  Readonly<{
    actionCount: number;
    commands: readonly ApplicationCommandData[];
  }>;

export const createProdActionRuntime = (
  logger: Logger,
  textCommandPrefix: string,
): ProdActionRuntime => {
  const context: ProdActionContext = { logger };
  const textProvider = createTextCommandProvider<ProdActionContext>({
    prefix: textCommandPrefix,
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

  return Object.freeze({
    actionCount: registry.actions.length,
    commands: getDiscordCommandRegistration(registry),
    refreshCommands: (client, developmentGuildId) =>
      registerDiscordCommands(client, registry, {
        target: { kind: "guild", guildId: developmentGuildId },
      }),
    handleInteraction: async (interaction: Interaction) => {
      const handled = await handleDiscordInteraction(
        registry,
        interaction,
        context,
      );
      logProdActionResult(logger, handled);
    },
    handleMessage: async (message: Message) => {
      const dispatched = await dispatchTextCommand({
        registry,
        provider: textProvider,
        message: {
          content: message.content,
          author: {
            id: message.author.id,
            username: message.author.username,
            globalName: message.author.globalName,
            bot: message.author.bot,
          },
          webhookId: message.webhookId,
          channelId: message.channelId,
          guildId: message.guildId,
        },
        context: {
          logger,
          replyToTextCommand: async (content) => {
            await message.reply({ content });
          },
        },
      });
      if (dispatched.consumed) {
        logActionDispatchResult(logger, dispatched.result);
      }
      return dispatched.consumed;
    },
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
