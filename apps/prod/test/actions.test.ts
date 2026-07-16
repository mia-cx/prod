import {
  ApplicationCommandType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type Message,
} from "discord.js";
import type { Logger } from "pino";
import type { DiscordInteractionHandleResult } from "protocord";
import { encodeSettingsCustomId } from "@protocord/settings";
import { describe, expect, it, vi } from "vitest";

import {
  createProdActionRuntime,
  logProdActionResult,
} from "../src/actions/runtime.js";
import { createLogger } from "../src/logger.js";

const noMentions = { parse: [], repliedUser: false };
const runtimeOptions = {
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
    isButton: () => false,
    isStringSelectMenu: () => false,
    isMentionableSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => kind === "slash",
    isMessageContextMenuCommand: () => kind === "message",
    isUserContextMenuCommand: () => kind === "user",
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
      interaction.ephemeral = true;
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

    expect(runtime.actionCount).toBe(2);
    expect(runtime.commands).toEqual([
      {
        type: ApplicationCommandType.ChatInput,
        name: "ping",
        description: "Check whether Prod is responsive",
        options: [],
      },
      {
        type: ApplicationCommandType.ChatInput,
        name: "settings",
        description: "Open the development settings validation surface",
        options: [],
        defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
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
    await runtime.refreshCommands(client);
    expect(guildSet).toHaveBeenCalledWith([]);
    expect(globalSet).toHaveBeenCalledWith(runtime.commands);
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

      const reply = {
        content: "pong!",
        allowedMentions: noMentions,
      };
      expect(interaction.reply).toHaveBeenCalledOnce();
      expect(interaction.reply).toHaveBeenCalledWith(reply);
      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(interaction.editReply).not.toHaveBeenCalled();
      expect(interaction.followUp).not.toHaveBeenCalled();
      expect(interaction.deleteReply).not.toHaveBeenCalled();
    },
  );

  it("opens the app-owned synthetic settings consumer through /settings", async () => {
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const interaction = settingsCommand(true);

    await runtime.handleInteraction(interaction as unknown as Interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.IsComponentsV2,
        components: expect.any(Array),
      }),
    );
    expect(JSON.stringify(interaction.editReply.mock.calls[0]?.[0])).toContain(
      "Prod development settings",
    );
  });

  it("routes synthetic component mutations before ordinary actions", async () => {
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const interaction = settingsButton(true);

    await runtime.handleInteraction(interaction as unknown as Interaction);

    expect(interaction.editReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(interaction.editReply.mock.calls[0]?.[0])).toContain(
      "1 refreshes",
    );
    expect(JSON.stringify(interaction.editReply.mock.calls[0]?.[0])).not.toContain(
      "Information refreshed.",
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("rechecks synthetic settings authorization for component mutations", async () => {
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const interaction = settingsButton(false);

    await runtime.handleInteraction(interaction as unknown as Interaction);

    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Manage Server permission is required for settings.",
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

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

    for (const content of [";", ";unknown"] as const) {
      const unmatchedReply = vi.fn().mockResolvedValue(undefined);
      const unmatchedMessage = {
        ...message,
        content,
        reply: unmatchedReply,
      } as unknown as Message;
      await expect(runtime.handleMessage!(unmatchedMessage)).resolves.toBe(
        false,
      );
      expect(unmatchedReply).not.toHaveBeenCalled();
    }

    const otherGuildReply = vi.fn().mockResolvedValue(undefined);
    const otherGuildMessage = {
      ...message,
      guildId: "guild-2",
      reply: otherGuildReply,
    } as unknown as Message;
    await expect(runtime.handleMessage!(otherGuildMessage)).resolves.toBe(true);
    expect(otherGuildReply).toHaveBeenCalledWith({
      content: "pong!",
      allowedMentions: noMentions,
    });
  });

  it("removes the text capability when the configured prefix is empty", () => {
    const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
      ...runtimeOptions,
      textCommandPrefix: " \t ",
    });

    expect(runtime.handleMessage).toBeUndefined();
    expect(runtime.commands).toHaveLength(4);
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

const settingsCommand = (canManageGuild: boolean) => {
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction: Record<string, unknown> = {
    commandName: "settings",
    channelId: "channel-1",
    guildId: "guild-1",
    user: { id: "user-1", username: "staff", globalName: "Staff" },
    memberPermissions: { has: () => canManageGuild },
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isMessageContextMenuCommand: () => false,
    isUserContextMenuCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isMentionableSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isModalSubmit: () => false,
    reply,
    followUp: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
      interaction.ephemeral = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
  return interaction as typeof interaction & {
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    deferReply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };
};

const settingsButton = (canManageGuild: boolean) => {
  const reply = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  const interaction: Record<string, unknown> = {
    customId: encodeSettingsCustomId({
      action: "button",
      categoryId: "controls",
      subcategoryId: "general",
      fieldId: "refresh",
      page: 0,
    }),
    guildId: "guild-1",
    user: { id: "user-1", username: "staff", globalName: "Staff" },
    memberPermissions: { has: () => canManageGuild },
    deferred: false,
    replied: false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isMentionableSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isModalSubmit: () => false,
    reply,
    followUp: vi.fn().mockResolvedValue(undefined),
    update,
    editReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    showModal: vi.fn().mockResolvedValue(undefined),
  };
  return interaction as typeof interaction & {
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };
};
