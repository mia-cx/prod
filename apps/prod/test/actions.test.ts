import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  MessageFlags,
  RESTJSONErrorCodes,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type Message,
} from "discord.js";
import type { Logger } from "pino";
import type { DiscordInteractionHandleResult } from "protocord";
import { encodeSettingsCustomId } from "@protocord/settings";
import { describe, expect, it, vi } from "vitest";

import type { GuildSettingsStore } from "../src/guild-settings.js";
import type { HubPermissionOwnership } from "../src/hub-permission-ownership.js";
import {
  createProdActionRuntime,
  logProdActionResult,
} from "../src/actions/runtime.js";
import { createLogger } from "../src/logger.js";
import type { SupportHubDiscord } from "../src/support-hub.js";
import {
  TicketSetupRequiredError,
  type TicketProvisioningService,
} from "../src/ticket-provisioning.js";
import { TicketAdmissionError } from "../src/tickets.js";

const noMentions = { parse: [], repliedUser: false };
const permissionOwnership: HubPermissionOwnership = {
  version: 1,
  channelId: "123456789012345678",
  botMemberId: "bot-1",
  everyone: {
    SendMessages: "unset",
    SendMessagesInThreads: "unset",
    CreatePublicThreads: "unset",
    CreatePrivateThreads: "unset",
  },
  bot: {
    SendMessages: "unset",
    SendMessagesInThreads: "unset",
    CreatePublicThreads: "unset",
    CreatePrivateThreads: "unset",
  },
};
const guildSettingsStore: GuildSettingsStore = {
  get: async (guildId) => ({
    guildId,
    initialized: true,
    hubChannelId: "123456789012345678",
    hubPermissionOwnership: permissionOwnership,
    assistantIdentity: "Prod",
    tone: "friendly, patient, and concise",
  }),
  initialize: async () => undefined,
  configureHub: async () => undefined,
  setHubInformationMessage: async () => undefined,
  setAssistantIdentity: async () => undefined,
  setTone: async () => undefined,
  getHubTransition: async () => undefined,
  beginHubTransition: async () => undefined,
  promoteHubTransition: async () => undefined,
  finishHubTransition: async () => undefined,
  abortHubTransition: async () => undefined,
};
const supportHubDiscord: SupportHubDiscord = {
  validateHub: vi.fn(async () => ({ valid: true as const })),
  prepareHub: async () => ({ valid: true, permissionOwnership }),
  applyHub: async () => ({ valid: true, permissionOwnership }),
  restoreHub: async () => undefined,
  releaseHub: async () => undefined,
  releaseFormerHub: async () => undefined,
  deletePublicThreads: vi.fn(async () => 0),
  upsertInformationMessage: async () => "message-1",
  deleteInformationMessage: async () => undefined,
};
const ticketProvisioningService: TicketProvisioningService = {
  open: vi.fn().mockResolvedValue({
    id: "ticket-1",
    guildId: "guild-1",
    hubChannelId: "channel-1",
    reporterUserId: "user-1",
    originatingAlias: "issue",
    status: "open",
    triageStatus: "collecting",
    threadId: "thread-1",
    openingMessageId: "message-1",
    createdAt: "2026-07-17T10:00:00.000Z",
    updatedAt: "2026-07-17T10:00:00.000Z",
  }),
  recover: vi.fn().mockResolvedValue({ recovered: 0, failed: 0 }),
  canReleaseHub: vi.fn().mockResolvedValue(true),
  suspendHubAccess: vi.fn().mockResolvedValue(0),
  resumeHubAccess: vi.fn().mockResolvedValue(0),
};
const runtimeOptions = {
  textCommandPrefix: "!",
  guildSettingsStore,
  supportHubDiscord,
  ticketProvisioningService,
};

function componentWithCustomId(
  value: unknown,
  customId: string,
): Readonly<Record<string, unknown>> | undefined {
  if (Array.isArray(value)) {
    return value
      .map((item) => componentWithCustomId(item, customId))
      .find((item) => item !== undefined);
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.custom_id === customId) return record;
  return Object.values(record)
    .map((item) => componentWithCustomId(item, customId))
    .find((item) => item !== undefined);
}

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

    expect(runtime.actionCount).toBe(3);
    expect(runtime.commands).toEqual([
      {
        type: ApplicationCommandType.ChatInput,
        name: "ping",
        description: "Check whether Prod is responsive",
        options: [],
      },
      ...(["issue", "report", "debugshare"] as const).map((name) => ({
        type: ApplicationCommandType.ChatInput,
        name,
        description: "Open a private support ticket",
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "summary",
            description: "A short summary of the problem",
            required: false,
            maxLength: 200,
          },
        ],
      })),
      {
        type: ApplicationCommandType.ChatInput,
        name: "settings",
        description: "Configure Prod for this server",
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
    expect(runtime.isApplicationOperator("operator-1")).toBe(false);
    runtime.setApplicationOperatorUserIds(["operator-1"]);
    expect(runtime.isApplicationOperator("operator-1")).toBe(true);
    runtime.setApplicationOperatorUserIds(["operator-2"]);
    expect(runtime.isApplicationOperator("operator-1")).toBe(false);
    expect(runtime.isApplicationOperator("operator-2")).toBe(true);
    const member = {
      id: "operator-2",
      guild: { id: "guild-1", ownerId: "owner-1" },
      roles: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
      permissions: { has: () => false },
    };
    expect(
      runtime.createUserAuthorizationSubject(member, { guildId: "guild-1" }),
    ).toMatchObject({
      subjectId: "operator-2",
      attributes: { isApplicationOperator: true },
    });

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

  it("opens settings with no category or subcategory selected", async () => {
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
      "Prod settings",
    );
    const payload = interaction.editReply.mock.calls[0]?.[0];
    expect(
      componentWithCustomId(
        payload,
        encodeSettingsCustomId({
          action: "category",
          categoryId: "setup",
          subcategoryId: "hub",
          page: 0,
        }),
      ),
    ).toMatchObject({
      min_values: 1,
      max_values: 1,
      options: [expect.objectContaining({ value: "setup" })],
    });
    expect(JSON.stringify(payload)).not.toContain("Support hub channel");
    expect(JSON.stringify(payload)).not.toContain('"default":true');
  });

  it("routes setup component mutations before ordinary actions", async () => {
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const interaction = settingsButton(true);

    await runtime.handleInteraction(interaction as unknown as Interaction);

    expect(interaction.editReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(interaction.editReply.mock.calls[0]?.[0])).toContain(
      "Hub information message",
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("rechecks bot operator access for settings opens and mutations", async () => {
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    runtime.setApplicationOperatorUserIds(["user-1"]);

    const open = settingsCommand(false);
    await runtime.handleInteraction(open as unknown as Interaction);
    expect(open.editReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(open.editReply.mock.calls[0]?.[0])).toContain(
      "Prod settings",
    );

    const mutation = settingsButton(false);
    await runtime.handleInteraction(mutation as unknown as Interaction);
    expect(mutation.editReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(mutation.editReply.mock.calls[0]?.[0])).toContain(
      "Hub information message",
    );

    runtime.setApplicationOperatorUserIds([]);
    const expiredMutation = settingsButton(false);
    await runtime.handleInteraction(expiredMutation as unknown as Interaction);
    expect(expiredMutation.editReply).not.toHaveBeenCalled();
    expect(expiredMutation.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Manage Server permission or bot operator access is required for settings.",
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  it("denies settings opens for ordinary guild members", async () => {
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const interaction = settingsCommand(false);

    await runtime.handleInteraction(interaction as unknown as Interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "You are not authorized to view settings.",
      allowedMentions: noMentions,
    });
  });

  it("rechecks guild setup authorization for component mutations", async () => {
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const interaction = settingsButton(false);

    await runtime.handleInteraction(interaction as unknown as Interaction);

    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Manage Server permission or bot operator access is required for settings.",
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

  it.each(["issue", "report", "debugshare"] as const)(
    "opens a private ticket ephemerally through /%s",
    async (alias) => {
      vi.mocked(ticketProvisioningService.open).mockClear();
      const runtime = createProdActionRuntime(
        createLogger({ level: "fatal" }),
        runtimeOptions,
      );
      const interaction = ticketInteraction(alias, "Poke crashes");

      await runtime.handleInteraction(interaction as unknown as Interaction);

      expect(interaction.deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(ticketProvisioningService.open).toHaveBeenCalledWith({
        guild: interaction.guild,
        reporterUserId: "user-1",
        originatingAlias: alias,
        summary: "Poke crashes",
      });
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: "https://discord.com/channels/guild-1/thread-1",
        allowedMentions: { parse: [] },
      });
    },
  );

  it("presents persistent ticket admission rejection without provisioning", async () => {
    vi.mocked(ticketProvisioningService.open).mockRejectedValueOnce(
      new TicketAdmissionError(
        "rate_limited",
        "Please wait a minute before opening another private ticket.",
      ),
    );
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const interaction = ticketInteraction("issue", null);

    await runtime.handleInteraction(interaction as unknown as Interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Please wait a minute before opening another private ticket.",
      allowedMentions: { parse: [] },
    });
  });

  it("tells ticket openers when support staff must configure the hub", async () => {
    vi.mocked(ticketProvisioningService.open).mockRejectedValueOnce(
      new TicketSetupRequiredError(),
    );
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const interaction = ticketInteraction("issue", null);

    await runtime.handleInteraction(interaction as unknown as Interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Support staff must configure a support hub before private tickets can be opened.",
      allowedMentions: { parse: [] },
    });
  });

  it("returns a minimal text-command link and deletes it after 30 seconds", async () => {
    vi.useFakeTimers();
    vi.mocked(ticketProvisioningService.open).mockClear();
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const deleteReply = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue({ delete: deleteReply });
    const message = {
      content: "!issue Poke crashes",
      author: {
        id: "user-1",
        username: "reporter",
        globalName: "Reporter",
        bot: false,
      },
      webhookId: null,
      channelId: "channel-1",
      guildId: "guild-1",
      guild: { id: "guild-1" },
      reply,
    } as unknown as Message;

    await expect(runtime.handleMessage!(message)).resolves.toBe(true);
    expect(ticketProvisioningService.open).toHaveBeenCalledWith({
      guild: message.guild,
      reporterUserId: "user-1",
      originatingAlias: "issue",
      summary: "Poke crashes",
    });
    expect(reply).toHaveBeenCalledWith({
      content: "https://discord.com/channels/guild-1/thread-1",
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(deleteReply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deleteReply).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("removes the text capability when the configured prefix is empty", () => {
    const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
      ...runtimeOptions,
      textCommandPrefix: " \t ",
    });

    expect(runtime.handleMessage).toBeUndefined();
    expect(runtime.handleHubMessage).toBeTypeOf("function");
    expect(runtime.commands).toHaveLength(7);
  });

  it("resolves guilds through the ready client during startup reconciliation", async () => {
    vi.mocked(supportHubDiscord.deletePublicThreads).mockClear();
    vi.mocked(ticketProvisioningService.resumeHubAccess).mockClear();
    vi.mocked(ticketProvisioningService.suspendHubAccess).mockClear();
    const fetchGuild = vi.fn().mockResolvedValue({ id: "guild-stale" });
    vi.mocked(ticketProvisioningService.recover).mockImplementationOnce(
      async (resolveGuild) => {
        expect(await resolveGuild("guild-stale")).toEqual({
          id: "guild-stale",
        });
        return { recovered: 1, failed: 0 };
      },
    );
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const client = {
      guilds: {
        fetch: fetchGuild,
        cache: new Map([["guild-1", { id: "guild-1" }]]),
      },
    } as unknown as Client<true>;

    await runtime.reconcile!(client);

    expect(ticketProvisioningService.recover).toHaveBeenCalledOnce();
    expect(supportHubDiscord.deletePublicThreads).toHaveBeenCalledWith(
      { id: "guild-1" },
      "123456789012345678",
    );
    expect(ticketProvisioningService.resumeHubAccess).toHaveBeenCalledWith(
      { id: "guild-1" },
      "123456789012345678",
    );
    expect(ticketProvisioningService.suspendHubAccess).not.toHaveBeenCalled();
    expect(fetchGuild).toHaveBeenCalledWith("guild-stale");
  });

  it("reconciles every guild before failing startup for unsafe hubs", async () => {
    const cleanupError = new Error("Discord unavailable");
    vi.mocked(supportHubDiscord.deletePublicThreads)
      .mockReset()
      .mockImplementation(async (guild) => {
        if (guild.id === "guild-1") throw cleanupError;
        return 0;
      });
    vi.mocked(ticketProvisioningService.suspendHubAccess).mockClear();
    vi.mocked(ticketProvisioningService.resumeHubAccess).mockClear();
    vi.mocked(ticketProvisioningService.recover).mockClear();
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const firstGuild = { id: "guild-1" };
    const secondGuild = { id: "guild-2" };
    const client = {
      guilds: {
        fetch: vi.fn(),
        cache: new Map([
          ["guild-1", firstGuild],
          ["guild-2", secondGuild],
        ]),
      },
    } as unknown as Client<true>;

    await expect(runtime.reconcile!(client)).rejects.toMatchObject({
      errors: [cleanupError],
    });

    expect(ticketProvisioningService.suspendHubAccess).toHaveBeenCalledWith(
      firstGuild,
      "123456789012345678",
    );
    expect(ticketProvisioningService.resumeHubAccess).toHaveBeenCalledWith(
      secondGuild,
      "123456789012345678",
    );
    expect(supportHubDiscord.deletePublicThreads).toHaveBeenCalledTimes(2);
    expect(ticketProvisioningService.recover).not.toHaveBeenCalled();
    vi.mocked(supportHubDiscord.deletePublicThreads).mockResolvedValue(0);
  });

  it("rolls back partial access resumption before startup recovery", async () => {
    const resumeError = new Error("second reporter grant failed");
    vi.mocked(supportHubDiscord.deletePublicThreads).mockResolvedValueOnce(0);
    vi.mocked(ticketProvisioningService.resumeHubAccess).mockRejectedValueOnce(
      resumeError,
    );
    vi.mocked(ticketProvisioningService.suspendHubAccess).mockClear();
    vi.mocked(ticketProvisioningService.recover).mockClear();
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const cachedGuild = { id: "guild-1" };
    const client = {
      guilds: { fetch: vi.fn(), cache: new Map([["guild-1", cachedGuild]]) },
    } as unknown as Client<true>;

    await expect(runtime.reconcile!(client)).rejects.toMatchObject({
      errors: [resumeError],
    });

    expect(ticketProvisioningService.suspendHubAccess).toHaveBeenCalledWith(
      cachedGuild,
      "123456789012345678",
    );
    expect(ticketProvisioningService.recover).not.toHaveBeenCalled();
  });

  it("deletes public thread drift only inside the configured support hub", async () => {
    vi.mocked(ticketProvisioningService.resumeHubAccess).mockClear();
    vi.mocked(ticketProvisioningService.suspendHubAccess).mockClear();
    const runtime = createProdActionRuntime(
      createLogger({ level: "fatal" }),
      runtimeOptions,
    );
    const remove = vi
      .fn()
      .mockRejectedValue({ code: RESTJSONErrorCodes.UnknownChannel });
    const threadGuild = { id: "guild-1" };
    const publicThread = {
      type: ChannelType.PublicThread,
      guildId: "guild-1",
      guild: threadGuild,
      parentId: "123456789012345678",
      delete: remove,
    };

    await runtime.handleThread!(publicThread as never);
    await runtime.handleThread!({
      ...publicThread,
      type: ChannelType.PrivateThread,
    } as never);
    await runtime.handleThread!({
      ...publicThread,
      parentId: "other-channel",
    } as never);

    expect(remove).toHaveBeenCalledOnce();
    expect(ticketProvisioningService.resumeHubAccess).toHaveBeenCalledWith(
      threadGuild,
      "123456789012345678",
    );
    expect(ticketProvisioningService.suspendHubAccess).not.toHaveBeenCalled();
  });

  it("revalidates parent history before resuming after public-thread cleanup", async () => {
    vi.useFakeTimers();
    const unsafeHistory = "unmanaged starter message remains";
    const unsafeHubDiscord = {
      ...supportHubDiscord,
      deletePublicThreads: vi.fn().mockResolvedValue(0),
      validateHub: vi
        .fn()
        .mockResolvedValue({ valid: false, issues: [unsafeHistory] }),
    };
    vi.mocked(ticketProvisioningService.resumeHubAccess).mockReset();
    vi.mocked(ticketProvisioningService.suspendHubAccess)
      .mockReset()
      .mockResolvedValue(0);
    const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
      ...runtimeOptions,
      supportHubDiscord: unsafeHubDiscord,
      hubSafetyRetryMs: 10,
    });
    const threadGuild = { id: "guild-1" };
    const publicThread = {
      type: ChannelType.PublicThread,
      guildId: "guild-1",
      guild: threadGuild,
      parentId: "123456789012345678",
      delete: vi.fn().mockResolvedValue(undefined),
    };

    await expect(runtime.handleThread!(publicThread as never)).rejects.toThrow(
      unsafeHistory,
    );

    expect(publicThread.delete).toHaveBeenCalledOnce();
    expect(unsafeHubDiscord.deletePublicThreads).toHaveBeenCalledWith(
      threadGuild,
      "123456789012345678",
    );
    expect(ticketProvisioningService.suspendHubAccess).toHaveBeenCalledWith(
      threadGuild,
      "123456789012345678",
    );
    expect(ticketProvisioningService.resumeHubAccess).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("suspends reporter access when live public drift cannot be deleted", async () => {
    vi.useFakeTimers();
    vi.mocked(ticketProvisioningService.resumeHubAccess).mockClear();
    vi.mocked(ticketProvisioningService.suspendHubAccess).mockClear();
    vi.mocked(supportHubDiscord.deletePublicThreads)
      .mockReset()
      .mockRejectedValueOnce(new Error("cleanup still unavailable"))
      .mockResolvedValue(0);
    const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
      ...runtimeOptions,
      hubSafetyRetryMs: 10,
    });
    const cleanupError = new Error("Discord unavailable");
    const threadGuild = { id: "guild-1" };
    const publicThread = {
      type: ChannelType.PublicThread,
      guildId: "guild-1",
      guild: threadGuild,
      parentId: "123456789012345678",
      delete: vi.fn().mockRejectedValue(cleanupError),
    };

    await expect(runtime.handleThread!(publicThread as never)).rejects.toBe(
      cleanupError,
    );

    expect(publicThread.delete).toHaveBeenCalledTimes(3);
    expect(ticketProvisioningService.suspendHubAccess).toHaveBeenCalledWith(
      threadGuild,
      "123456789012345678",
    );
    expect(ticketProvisioningService.resumeHubAccess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(supportHubDiscord.deletePublicThreads).toHaveBeenCalledOnce();
    expect(ticketProvisioningService.suspendHubAccess).toHaveBeenCalledTimes(2);
    expect(ticketProvisioningService.resumeHubAccess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(supportHubDiscord.deletePublicThreads).toHaveBeenCalledTimes(2);
    expect(ticketProvisioningService.resumeHubAccess).toHaveBeenCalledWith(
      threadGuild,
      "123456789012345678",
    );
    vi.useRealTimers();
  });

  it("does not resume access on a former hub from a stale retry", async () => {
    vi.useFakeTimers();
    let configuredHub = "123456789012345678";
    const changingSettings = {
      ...guildSettingsStore,
      get: vi.fn(async (guildId: string) => ({
        ...(await guildSettingsStore.get(guildId)),
        hubChannelId: configuredHub,
      })),
    };
    vi.mocked(ticketProvisioningService.resumeHubAccess).mockClear();
    vi.mocked(ticketProvisioningService.suspendHubAccess).mockClear();
    vi.mocked(supportHubDiscord.deletePublicThreads).mockClear();
    const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
      ...runtimeOptions,
      guildSettingsStore: changingSettings,
      hubSafetyRetryMs: 10,
    });
    const cleanupError = new Error("Discord unavailable");
    const threadGuild = { id: "guild-1" };

    await expect(
      runtime.handleThread!({
        type: ChannelType.PublicThread,
        guildId: "guild-1",
        guild: threadGuild,
        parentId: configuredHub,
        delete: vi.fn().mockRejectedValue(cleanupError),
      } as never),
    ).rejects.toBe(cleanupError);
    configuredHub = "hub-2";
    await vi.advanceTimersByTimeAsync(10);

    expect(supportHubDiscord.deletePublicThreads).not.toHaveBeenCalled();
    expect(ticketProvisioningService.resumeHubAccess).not.toHaveBeenCalled();
    expect(ticketProvisioningService.suspendHubAccess).toHaveBeenCalledTimes(2);
    expect(ticketProvisioningService.suspendHubAccess).toHaveBeenLastCalledWith(
      threadGuild,
      "123456789012345678",
    );
    vi.useRealTimers();
  });

  it("suspends on unmanaged live hub messages until a clean scan succeeds", async () => {
    vi.useFakeTimers();
    const unsafeHistory = "unmanaged messages remain";
    vi.mocked(supportHubDiscord.deletePublicThreads).mockResolvedValue(0);
    vi.mocked(supportHubDiscord.validateHub)
      .mockReset()
      .mockResolvedValueOnce({ valid: false, issues: [unsafeHistory] })
      .mockResolvedValueOnce({ valid: false, issues: [unsafeHistory] })
      .mockResolvedValue({ valid: true });
    vi.mocked(ticketProvisioningService.resumeHubAccess).mockReset();
    vi.mocked(ticketProvisioningService.suspendHubAccess).mockClear();
    const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
      ...runtimeOptions,
      hubSafetyRetryMs: 10,
    });
    const message = {
      guild: { id: "guild-1" },
      guildId: "guild-1",
      channelId: "123456789012345678",
    };

    await expect(runtime.handleHubMessage!(message as never)).rejects.toThrow(
      unsafeHistory,
    );
    expect(ticketProvisioningService.suspendHubAccess).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    expect(ticketProvisioningService.suspendHubAccess).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(ticketProvisioningService.resumeHubAccess).toHaveBeenCalledOnce();
    vi.useRealTimers();
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
    guild: { id: "guild-1", ownerId: "owner-1" },
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

const ticketInteraction = (
  alias: "issue" | "report" | "debugshare",
  summary: string | null,
) => {
  const interaction: Record<string, unknown> = {
    commandName: alias,
    channelId: "channel-1",
    guildId: "guild-1",
    guild: { id: "guild-1" },
    user: { id: "user-1", username: "reporter", globalName: "Reporter" },
    options: { getString: () => summary },
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
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
  return interaction as typeof interaction & {
    guild: { id: string };
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
      categoryId: "setup",
      subcategoryId: "hub",
      fieldId: "hub-information",
      page: 0,
    }),
    guildId: "guild-1",
    guild: { id: "guild-1", ownerId: "owner-1" },
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
