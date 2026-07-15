import type { ApplicationCommandData, Interaction } from "discord.js";
import type { Logger } from "pino";
import {
  createActionRegistry,
  createDiscordInteractionProviders,
  getDiscordCommandRegistration,
  handleDiscordInteraction,
  registerDiscordCommands,
  type DiscordInteractionHandleResult,
} from "protocord";

import type { DiscordActionSurface } from "../discord.js";
import { pingAction } from "./ping.js";

export type ProdActionContext = Readonly<{
  logger: Logger;
}>;

export type ProdActionRuntime = DiscordActionSurface &
  Readonly<{
    actionCount: number;
    commands: readonly ApplicationCommandData[];
  }>;

export const createProdActionRuntime = (logger: Logger): ProdActionRuntime => {
  const context: ProdActionContext = { logger };
  const registry = createActionRegistry<ProdActionContext>({
    providers: createDiscordInteractionProviders<ProdActionContext>(),
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

  const details = {
    action: handled.result.actionName,
    trigger: handled.result.triggerName,
  };
  if (handled.result.outcome.status === "failed") {
    logger.error(
      { ...details, err: handled.result.outcome.error },
      "Discord action lifecycle failed",
    );
  }
  if (handled.result.presentationError !== undefined) {
    logger.error(
      { ...details, err: handled.result.presentationError },
      "failed to present action result",
    );
  }
};
