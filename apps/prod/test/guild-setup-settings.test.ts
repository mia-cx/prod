import {
  ChannelType,
  Collection,
  MessageFlags,
  PermissionFlagsBits,
  TextInputStyle,
  type Client,
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
import type { HubTransition } from "../src/hub-transition.js";
import { createLogger } from "../src/logger.js";
import { applyMigrations } from "../src/migrations.js";
import type { SupportHubDiscord } from "../src/support-hub.js";
import type { TicketProvisioningService } from "../src/ticket-provisioning.js";

const guildId = "123456789012345670";
const hubChannelId = "123456789012345671";
const replacementHubChannelId = "123456789012345679";
const informationMessageId = "123456789012345672";
const ownerId = "123456789012345673";
const administratorId = "123456789012345674";
const managerId = "123456789012345675";
const operatorId = "123456789012345676";

const connections: DatabaseConnection[] = [];
const ticketProvisioningService: TicketProvisioningService = {
  open: vi.fn(),
  recover: vi.fn().mockResolvedValue({ recovered: 0, failed: 0 }),
  canReleaseHub: vi.fn().mockResolvedValue(true),
  suspendHubAccess: vi.fn().mockResolvedValue(0),
  resumeHubAccess: vi.fn().mockResolvedValue(0),
};

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
    releaseFormerHub: vi.fn(async () => undefined),
    deletePublicThreads: vi.fn(async () => 0),
    upsertInformationMessage: vi.fn(async () => informationMessageId),
    deleteInformationMessage: vi.fn(async () => undefined),
    ...overrides,
  };
  const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
    textCommandPrefix: "",
    guildSettingsStore: store,
    supportHubDiscord: supportHub,
    ticketProvisioningService,
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
    showModal: ReturnType<typeof vi.fn>;
  };
};

type ComponentKind = "button" | "channel" | "modal" | "string";

const component = (
  kind: ComponentKind,
  route: Parameters<typeof encodeSettingsCustomId>[0],
  options: Readonly<{
    userId?: string;
    allowed?: readonly PermissionResolvable[];
    modalValue?: string;
    selectedValues?: readonly string[];
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
    values:
      kind === "channel"
        ? [hubChannelId]
        : kind === "string"
          ? (options.selectedValues ?? [])
          : [],
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
    isStringSelectMenu: () => kind === "string",
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
    showModal: ReturnType<typeof vi.fn>;
  };
};

const hubRoute = {
  action: "channel-select",
  categoryId: "setup",
  subcategoryId: "setup",
  fieldId: "hub-channel",
  page: 0,
} as const;

const modalRoute = (
  fieldId:
    | "assistant-system-prompt"
    | "assistant-product"
    | "assistant-workflow"
    | "assistant-safety"
    | "assistant-style-prompt",
) => ({
  action: "modal-submit" as const,
  categoryId: "identity",
  subcategoryId: "personality",
  fieldId,
  page:
    fieldId === "assistant-safety" || fieldId === "assistant-style-prompt"
      ? 1
      : 0,
});

describe("guild setup settings integration", () => {
  it("renders direct Setup fields and nested Identity pages", async () => {
    const { runtime } = await setup();
    const opened = command(ownerId);
    await runtime.handleInteraction(opened as unknown as Interaction);
    const home = JSON.stringify(opened.editReply.mock.calls[0]?.[0]);
    expect(home).toContain("Setup");
    expect(home).toContain("Identity");
    expect(home).not.toContain("⚙️");
    expect(home).not.toContain("🪪");
    expect(home).not.toContain("Empty-hub privacy");

    const setupCategory = component(
      "string",
      {
        action: "category",
        categoryId: "setup",
        subcategoryId: "setup",
        page: 0,
      },
      { selectedValues: ["setup"] },
    );
    await runtime.handleInteraction(setupCategory as unknown as Interaction);
    const setupPage = JSON.stringify(setupCategory.editReply.mock.calls[0]?.[0]);
    expect(setupPage).toContain("Configure basic setup for Prod.");
    expect(setupPage).toContain("## Support channel");
    expect(setupPage).toContain("Choose where Prod manages support threads.");
    expect(setupPage).not.toContain("Choose a settings page");
    expect(setupPage).not.toContain("**Current:**");
    expect(setupPage).not.toContain("Empty-hub privacy");

    const identityCategory = component(
      "string",
      {
        action: "category",
        categoryId: "setup",
        subcategoryId: "setup",
        page: 0,
      },
      { selectedValues: ["identity"] },
    );
    await runtime.handleInteraction(identityCategory as unknown as Interaction);
    const identityPage = JSON.stringify(
      identityCategory.editReply.mock.calls[0]?.[0],
    );
    expect(identityPage).toContain(
      "Configure Prod's personality and knowledge.",
    );
    expect(identityPage).toContain("Personality");
    expect(identityPage).toContain(
      "Configure how Prod communicates with users.",
    );
    expect(identityPage).toContain("Knowledge base");
    expect(identityPage).toContain(
      "Manage reusable fixes Prod can suggest to users.",
    );
    expect(identityPage).not.toContain("Style prompt");

    const personality = component(
      "string",
      {
        action: "subcategory",
        categoryId: "identity",
        subcategoryId: "personality",
        page: 0,
      },
      { selectedValues: ["personality"] },
    );
    await runtime.handleInteraction(personality as unknown as Interaction);
    const personalityPage = JSON.stringify(
      personality.editReply.mock.calls[0]?.[0],
    );
    expect(personalityPage).toContain("**Role**");
    expect(personalityPage).toContain("**Product knowledge**");
    expect(personalityPage).toContain("**Support workflow**");
    expect(personalityPage).toContain(
      "you are an automated support agent for Poke",
    );
    expect(personalityPage).toContain(
      "Configure how Prod communicates with users.",
    );
    expect(personalityPage).not.toContain("assistant-identity");
    expect(personalityPage).not.toContain("**Name:**");
    expect(personalityPage).not.toContain("**Current:**");

    const personalityPageTwo = component("button", {
      action: "page",
      categoryId: "identity",
      subcategoryId: "personality",
      page: 1,
    });
    await runtime.handleInteraction(
      personalityPageTwo as unknown as Interaction,
    );
    const secondPersonalityPage = JSON.stringify(
      personalityPageTwo.editReply.mock.calls[0]?.[0],
    );
    expect(secondPersonalityPage).toContain("**Safety**");
    expect(secondPersonalityPage).toContain("**Style prompt**");
    expect(secondPersonalityPage).toContain(
      "write responses in lowercase only",
    );

    const styleButton = component("button", {
      action: "modal",
      categoryId: "identity",
      subcategoryId: "personality",
      fieldId: "assistant-style-prompt",
      page: 0,
    });
    await runtime.handleInteraction(styleButton as unknown as Interaction);
    expect(styleButton.showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        components: [
          expect.objectContaining({
            component: expect.objectContaining({
              style: TextInputStyle.Paragraph,
            }),
          }),
        ],
      }),
    );
    expect(
      styleButton.showModal.mock.calls[0]?.[0]?.components[0]?.component,
    ).not.toHaveProperty("max_length");
  });

  it("recovers a promoted hub transition before resuming the replacement hub", async () => {
    const { runtime, store, supportHub } = await setup();
    await store.configureHub(guildId, hubChannelId, ownership(hubChannelId));
    const transition: HubTransition = {
      version: 1,
      id: "transition-restart",
      phase: "prepared",
      previous: {
        hubChannelId,
        hubPermissionOwnership: ownership(hubChannelId),
      },
      next: ownership(replacementHubChannelId),
    };
    await store.beginHubTransition(guildId, transition);
    await store.promoteHubTransition(guildId, transition);
    vi.mocked(ticketProvisioningService.suspendHubAccess)
      .mockReset()
      .mockRejectedValueOnce(new Error("transient suspension failure"))
      .mockResolvedValue(2);
    vi.mocked(ticketProvisioningService.resumeHubAccess).mockClear();
    const client = {
      guilds: { fetch: vi.fn(), cache: new Map([[guildId, guild]]) },
    } as unknown as Client<true>;

    await expect(runtime.reconcile!(client)).rejects.toThrow(
      "One or more support hubs",
    );
    expect(supportHub.releaseFormerHub).not.toHaveBeenCalled();
    expect(ticketProvisioningService.resumeHubAccess).not.toHaveBeenCalled();
    await expect(store.getHubTransition(guildId)).resolves.toMatchObject({
      phase: "promoted",
    });

    await runtime.reconcile!(client);

    expect(ticketProvisioningService.suspendHubAccess).toHaveBeenCalledTimes(2);
    expect(supportHub.releaseFormerHub).toHaveBeenCalledWith(
      guild,
      ownership(hubChannelId),
    );
    expect(ticketProvisioningService.resumeHubAccess).toHaveBeenCalledWith(
      guild,
      replacementHubChannelId,
    );
    expect(
      vi.mocked(supportHub.releaseFormerHub).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(ticketProvisioningService.resumeHubAccess).mock
        .invocationCallOrder[0]!,
    );
    await expect(store.getHubTransition(guildId)).resolves.toBeUndefined();
  });

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

  it("persists and rerenders prompt sections separately", async () => {
    const { connection, runtime, store } = await setup();
    await store.configureHub(guildId, hubChannelId, ownership());

    const systemPrompt = component(
      "modal",
      modalRoute("assistant-system-prompt"),
      { modalValue: "  help users complete their reports  " },
    );
    await runtime.handleInteraction(systemPrompt as unknown as Interaction);
    expect(
      JSON.stringify(systemPrompt.editReply.mock.calls[0]?.[0]),
    ).toContain("help users complete their reports");

    const productKnowledge = component(
      "modal",
      modalRoute("assistant-product"),
      { modalValue: "  poke works in messaging channels  " },
    );
    await runtime.handleInteraction(
      productKnowledge as unknown as Interaction,
    );

    const supportWorkflow = component(
      "modal",
      modalRoute("assistant-workflow"),
      { modalValue: "  collect exact reproduction steps  " },
    );
    await runtime.handleInteraction(supportWorkflow as unknown as Interaction);

    const safety = component(
      "modal",
      modalRoute("assistant-safety"),
      { modalValue: "  never request user secrets  " },
    );
    await runtime.handleInteraction(safety as unknown as Interaction);

    const tone = component("modal", modalRoute("assistant-style-prompt"), {
      modalValue: "  lowercase, direct, and concise  ",
    });
    await runtime.handleInteraction(tone as unknown as Interaction);
    expect(JSON.stringify(tone.editReply.mock.calls[0]?.[0])).toContain(
      "lowercase, direct, and concise",
    );

    const restartedStore = createSqliteGuildSettingsStore(connection.database);
    await expect(restartedStore.get(guildId)).resolves.toMatchObject({
      assistantIdentity: "Prod",
      systemPrompt: "help users complete their reports",
      productKnowledgePrompt: "poke works in messaging channels",
      supportWorkflowPrompt: "collect exact reproduction steps",
      safetyPrompt: "never request user secrets",
      tone: "lowercase, direct, and concise",
    });
  });
});
