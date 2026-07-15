import {
  ApplicationCommandType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from "discord.js";
import type { Logger } from "pino";
import type { DiscordInteractionHandleResult } from "protocord";
import { describe, expect, it, vi } from "vitest";

import {
  createProdActionRuntime,
  logProdActionResult,
} from "../src/actions/runtime.js";
import { createLogger } from "../src/logger.js";

const pingInteraction = (): ChatInputCommandInteraction => {
  const interaction: Record<string, unknown> = {
    commandName: "ping",
    channelId: "channel-1",
    guildId: "guild-1",
    user: { id: "user-1", username: "reporter", globalName: "Reporter" },
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isMessageContextMenuCommand: () => false,
    isUserContextMenuCommand: () => false,
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
  return interaction as unknown as ChatInputCommandInteraction;
};

describe("Prod action runtime", () => {
  it("registers only /ping and replies with pong", async () => {
    const runtime = createProdActionRuntime(createLogger({ level: "fatal" }));
    const interaction = pingInteraction();

    expect(runtime.actionCount).toBe(1);
    expect(runtime.commands).toEqual([
      {
        type: ApplicationCommandType.ChatInput,
        name: "ping",
        description: "Check whether Prod is responsive",
        options: [],
      },
    ]);

    const globalSet = vi.fn().mockResolvedValue(undefined);
    const guildSet = vi.fn().mockResolvedValue(undefined);
    const client = {
      application: { commands: { set: globalSet } },
      guilds: {
        cache: new Map([["guild-1", { commands: { set: guildSet } }]]),
        fetch: vi.fn(),
      },
    } as unknown as Client<true>;
    await runtime.refreshCommands(client, "guild-1");
    expect(globalSet).toHaveBeenCalledWith([]);
    expect(guildSet).toHaveBeenCalledWith(runtime.commands);

    await runtime.handleInteraction(interaction as unknown as Interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.deleteReply).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({ content: "pong!" });
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it.each([
    ["lifecycle", true, false, 1],
    ["presentation", false, true, 1],
    ["both", true, true, 2],
  ] as const)(
    "logs %s failures without losing either error",
    (_name, lifecycleFailed, presentationFailed, expectedCalls) => {
      const lifecycleError = new Error("action failed");
      const presentationError = new Error("Discord failed");
      const error = vi.fn();
      const logger = { error } as unknown as Logger;
      const handled: DiscordInteractionHandleResult = {
        handled: true,
        type: "command",
        result: {
          matched: true,
          actionName: "fixture",
          triggerName: "fixture-trigger",
          outcome: lifecycleFailed
            ? { status: "failed", error: lifecycleError }
            : { status: "executed", output: "done" },
          ...(presentationFailed ? { presentationError } : {}),
        },
      };

      logProdActionResult(logger, handled);

      expect(error).toHaveBeenCalledTimes(expectedCalls);
      if (lifecycleFailed) {
        expect(error).toHaveBeenCalledWith(
          {
            action: "fixture",
            trigger: "fixture-trigger",
            err: lifecycleError,
          },
          "Discord action lifecycle failed",
        );
      }
      if (presentationFailed) {
        expect(error).toHaveBeenCalledWith(
          {
            action: "fixture",
            trigger: "fixture-trigger",
            err: presentationError,
          },
          "failed to present action result",
        );
      }
    },
  );
});
