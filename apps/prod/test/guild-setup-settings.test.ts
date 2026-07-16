import {
  ChannelType,
  Collection,
  MessageFlags,
  PermissionFlagsBits,
  type Guild,
  type Interaction,
  type PermissionResolvable,
} from "discord.js";
import { encodeSettingsCustomId } from "@protocord/settings";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProdActionRuntime } from "../src/actions/runtime.js";
import { openDatabase, type DatabaseConnection } from "../src/database.js";
import { createSqliteGuildSettingsStore } from "../src/guild-settings.js";
import type { HubPermissionOwnership } from "../src/hub-permission-ownership.js";
import { createLogger } from "../src/logger.js";
import { applyMigrations } from "../src/migrations.js";
import type { SupportHubDiscord } from "../src/support-hub.js";

const guildId = "123456789012345670";
const hubChannelId = "123456789012345671";
const informationMessageId = "123456789012345672";
const ownerId = "123456789012345673";
const administratorId = "123456789012345674";
const managerId = "123456789012345675";
const operatorId = "123456789012345676";

const connections: DatabaseConnection[] = [];

const ownership = (channelId = hubChannelId): HubPermissionOwnership => ({
  version: 1,
  channelId,
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
});

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

const setup = async (overrides: Partial<SupportHubDiscord> = {}) => {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  await applyMigrations(connection.database);
  const store = createSqliteGuildSettingsStore(connection.database);
  const supportHub: SupportHubDiscord = {
    validateHub: vi.fn(async () => ({ valid: true as const })),
    prepareHub: vi.fn(async (_guild, channelId, existingOwnership) => ({
      valid: true as const,
      permissionOwnership: existingOwnership ?? ownership(channelId),
    })),
    applyHub: vi.fn(async (_guild, permissionOwnership) => ({
      valid: true as const,
      permissionOwnership,
    })),
    restoreHub: vi.fn(async () => undefined),
    releaseHub: vi.fn(async () => undefined),
    upsertInformationMessage: vi.fn(async () => informationMessageId),
    deleteInformationMessage: vi.fn(async () => undefined),
    ...overrides,
  };
  const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
    textCommandPrefix: "",
    guildSettingsStore: store,
    supportHubDiscord: supportHub,
  });
  return { connection, store, supportHub, runtime };
};

const guild = {
  id: guildId,
  ownerId,
} as Guild;

const permissions = (...allowed: readonly PermissionResolvable[]) => ({
  has: (permission: PermissionResolvable) => allowed.includes(permission),
});

const command = (
  userId: string,
  allowed: readonly PermissionResolvable[] = [],
) => {
  const interaction: Record<string, unknown> = {
    commandName: "settings",
    guild,
    guildId,
    user: { id: userId, username: "staff", globalName: "Staff" },
    memberPermissions: permissions(...allowed),
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
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
      interaction.ephemeral = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
  return interaction as typeof interaction & {
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };
};

type ComponentKind = "button" | "channel" | "modal";

const component = (
  kind: ComponentKind,
  route: Parameters<typeof encodeSettingsCustomId>[0],
  options: Readonly<{
    userId?: string;
    allowed?: readonly PermissionResolvable[];
    modalValue?: string;
  }> = {},
) => {
  const interaction: Record<string, unknown> = {
    customId: encodeSettingsCustomId(route),
    guild,
    guildId,
    user: {
      id: options.userId ?? administratorId,
      username: "staff",
      globalName: "Staff",
    },
    memberPermissions: permissions(
      ...(options.allowed ?? [PermissionFlagsBits.Administrator]),
    ),
    deferred: false,
    replied: false,
    message: { id: "123456789012345699" },
    values: kind === "channel" ? [hubChannelId] : [],
    channels: new Collection([
      [
        hubChannelId,
        {
          id: hubChannelId,
          name: "support-hub",
          type: ChannelType.GuildText,
        },
      ],
    ]),
    fields: {
      getTextInputValue: () => options.modalValue ?? "",
    },
    isFromMessage: () => true,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isMessageContextMenuCommand: () => false,
    isUserContextMenuCommand: () => false,
    isButton: () => kind === "button",
    isStringSelectMenu: () => false,
    isMentionableSelectMenu: () => false,
    isChannelSelectMenu: () => kind === "channel",
    isModalSubmit: () => kind === "modal",
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    showModal: vi.fn().mockResolvedValue(undefined),
  };
  return interaction as typeof interaction & {
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };
};

const hubRoute = {
  action: "channel-select",
  categoryId: "setup",
  subcategoryId: "hub",
  fieldId: "hub-channel",
  page: 0,
} as const;

const informationRoute = {
  action: "button",
  categoryId: "setup",
  subcategoryId: "hub",
  fieldId: "hub-information",
  page: 0,
} as const;

const modalRoute = (fieldId: "assistant-identity" | "assistant-tone") => ({
  action: "modal-submit" as const,
  categoryId: "setup",
  subcategoryId: "assistant",
  fieldId,
  page: 0,
});

describe("guild setup settings integration", () => {
  it("allows only the owner or an administrator to bootstrap, then permits Manage Server", async () => {
    const { runtime, store } = await setup();
    runtime.setApplicationOperatorUserIds([operatorId]);

    for (const denied of [
      command(managerId, [PermissionFlagsBits.ManageGuild]),
      command(operatorId),
    ]) {
      await runtime.handleInteraction(denied as unknown as Interaction);
      expect(denied.editReply).toHaveBeenCalledWith({
        content: "You are not authorized to view settings.",
        allowedMentions: { parse: [], repliedUser: false },
      });
    }

    for (const allowed of [
      command(ownerId),
      command(administratorId, [PermissionFlagsBits.Administrator]),
    ]) {
      await runtime.handleInteraction(allowed as unknown as Interaction);
      expect(allowed.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: MessageFlags.IsComponentsV2 }),
      );
    }

    const select = component("channel", hubRoute);
    await runtime.handleInteraction(select as unknown as Interaction);
    expect(await store.get(guildId)).toMatchObject({ hubChannelId });

    const manager = command(managerId, [PermissionFlagsBits.ManageGuild]);
    await runtime.handleInteraction(manager as unknown as Interaction);
    expect(manager.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.IsComponentsV2 }),
    );
  });

  it("shows hub validation failures without configuring the guild", async () => {
    const validateHub = vi.fn(async () => ({
      valid: false as const,
      issues: ["Prod is missing required permissions in this channel."],
    }));
    const prepareHub = vi.fn(async () => ({
      valid: true as const,
      permissionOwnership: ownership(),
    }));
    const { runtime, store } = await setup({ validateHub, prepareHub });
    const select = component("channel", hubRoute);

    await runtime.handleInteraction(select as unknown as Interaction);

    expect(validateHub).toHaveBeenCalledWith(guild, hubChannelId);
    expect(prepareHub).not.toHaveBeenCalled();
    expect((await store.get(guildId)).hubChannelId).toBeUndefined();
    expect(JSON.stringify(select.editReply.mock.calls[0]?.[0])).toContain(
      "Prod is missing required permissions",
    );
  });

  it("persists one information message ID across repeated refreshes", async () => {
    const upsertInformationMessage = vi.fn(async () => informationMessageId);
    const { runtime, store } = await setup({ upsertInformationMessage });
    await store.configureHub(guildId, hubChannelId, ownership());

    const first = component("button", informationRoute);
    await runtime.handleInteraction(first as unknown as Interaction);
    const second = component("button", informationRoute);
    await runtime.handleInteraction(second as unknown as Interaction);

    expect(upsertInformationMessage).toHaveBeenNthCalledWith(1, {
      guild,
      channelId: hubChannelId,
      assistantIdentity: "Prod",
    });
    expect(upsertInformationMessage).toHaveBeenNthCalledWith(2, {
      guild,
      channelId: hubChannelId,
      assistantIdentity: "Prod",
      messageId: informationMessageId,
    });
    expect((await store.get(guildId)).hubInformationMessageId).toBe(
      informationMessageId,
    );
  });

  it("persists and rerenders assistant identity and tone", async () => {
    const { connection, runtime, store } = await setup();
    await store.configureHub(guildId, hubChannelId, ownership());

    const identity = component("modal", modalRoute("assistant-identity"), {
      modalValue: "  Support Guide  ",
    });
    await runtime.handleInteraction(identity as unknown as Interaction);
    expect(JSON.stringify(identity.editReply.mock.calls[0]?.[0])).toContain(
      "Support Guide",
    );

    const tone = component("modal", modalRoute("assistant-tone"), {
      modalValue: "  warm, direct, and concise  ",
    });
    await runtime.handleInteraction(tone as unknown as Interaction);
    expect(JSON.stringify(tone.editReply.mock.calls[0]?.[0])).toContain(
      "warm, direct, and concise",
    );

    const restartedStore = createSqliteGuildSettingsStore(connection.database);
    await expect(restartedStore.get(guildId)).resolves.toMatchObject({
      assistantIdentity: "Support Guide",
      tone: "warm, direct, and concise",
    });
  });
});
