import {
  ApplicationCommandType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type Message,
} from "discord.js";
import type { Logger } from "pino";
import type { DiscordInteractionHandleResult } from "protocord";
import { describe, expect, it, vi } from "vitest";

import {
  createProdActionRuntime,
  logProdActionResult,
} from "../src/actions/runtime.js";
import { createLogger } from "../src/logger.js";

const noMentions = { parse: [], repliedUser: false };
const runtimeOptions = {
  developmentGuildId: "guild-1",
  textCommandPrefix: "!",
};

type PingInteractionKind = "message" | "slash" | "user";

const pingInteraction = (
  kind: PingInteractionKind,
): ChatInputCommandInteraction => {
  const interaction: Record<string, unknown> = {
    commandName: kind === "slash" ? "ping" : "Ping Prod",
    channelId: "channel-1",
    guildId: "guild-1",
    user: { id: "user-1", username: "reporter", globalName: "Reporter" },
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => kind === "slash",
    isMessageContextMenuCommand: () => kind === "message",
    isUserContextMenuCommand: () => kind === "user",
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
  it("registers every Discord ping surface from one action", async () => {
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );

    expect(runtime.actionCount).toBe(1);
    expect(runtime.commands).toEqual([
      {
        type: ApplicationCommandType.ChatInput,
        name: "ping",
        description: "Check whether Prod is responsive",
        options: [],
      },
      {
        type: ApplicationCommandType.Message,
        name: "Ping Prod",
      },
      {
        type: ApplicationCommandType.User,
        name: "Ping Prod",
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
  });

  it.each(["slash", "message", "user"] as const)(
    "replies publicly with pong through the %s surface",
    async (kind) => {
      const runtime = createProdActionRuntime(
        createLogger({ level: "fatal" }),
        runtimeOptions,
      );
      const interaction = pingInteraction(kind);

      await runtime.handleInteraction(interaction as unknown as Interaction);

      expect(interaction.deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(interaction.deleteReply).toHaveBeenCalledOnce();
      expect(interaction.followUp).toHaveBeenCalledWith({
        content: "pong!",
        allowedMentions: noMentions,
      });
      expect(interaction.editReply).not.toHaveBeenCalled();
    },
  );

  it("uses the configured prefix and replies with pong through text", async () => {
    const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
      ...runtimeOptions,
      textCommandPrefix: ";",
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    const message = {
      content: ";ping",
      author: {
        id: "user-1",
        username: "reporter",
        globalName: "Reporter",
        bot: false,
      },
      webhookId: null,
      channelId: "channel-1",
      guildId: "guild-1",
      reply,
    } as unknown as Message;

    expect(runtime.handleMessage).toBeDefined();
    await expect(runtime.handleMessage!(message)).resolves.toBe(true);
    expect(reply).toHaveBeenCalledWith({
      content: "pong!",
      allowedMentions: noMentions,
    });

    const otherGuildReply = vi.fn().mockResolvedValue(undefined);
    const otherGuildMessage = {
      ...message,
      guildId: "guild-2",
      reply: otherGuildReply,
    } as unknown as Message;
    await expect(runtime.handleMessage!(otherGuildMessage)).resolves.toBe(
      false,
    );
    expect(otherGuildReply).not.toHaveBeenCalled();
  });

  it("removes the text capability when the configured prefix is empty", () => {
    const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
      ...runtimeOptions,
      textCommandPrefix: " \t ",
    });

    expect(runtime.handleMessage).toBeUndefined();
    expect(runtime.commands).toHaveLength(3);
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
          "action lifecycle failed",
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
