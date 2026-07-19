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
import { createSqlitePermissionRuleStore } from "@protocord/permissions";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProdActionRuntime } from "../src/actions/runtime.js";
import {
  createProdAuthorizationService,
  createProdPermissionRuleStore,
} from "../src/authorization.js";
import { openDatabase, type DatabaseConnection } from "../src/database.js";
import { createSqliteGuildSettingsStore } from "../src/guild-settings.js";
import {
  MAX_LABELS,
  createSqliteLabelTaxonomyStore,
} from "../src/label-taxonomy.js";
import type { HubPermissionOwnership } from "../src/hub-permission-ownership.js";
import type { HubTransition } from "../src/hub-transition.js";
import { createLogger } from "../src/logger.js";
import { applyMigrations } from "../src/migrations.js";
import { createPermissionAdministrationService } from "../src/permission-administration.js";
import { createPermissionContributionStore } from "../src/permission-contribution-store.js";
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
  discoverRecoveryThreads: vi.fn().mockResolvedValue({
    discovered: 0,
    failed: 0,
  }),
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

const setup = async (
  overrides: Partial<SupportHubDiscord> = {},
  withPermissionSettings = false,
) => {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  await applyMigrations(connection.database);
  const store = createSqliteGuildSettingsStore(connection.database);
  const labelStore = createSqliteLabelTaxonomyStore(connection.database);
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
    upsertInformationMessage: vi.fn(async () => informationMessageId),
    deleteInformationMessage: vi.fn(async () => undefined),
    ...overrides,
  };
  const sqliteRules = createSqlitePermissionRuleStore(connection.database);
  const permissionAuthorization = createProdAuthorizationService({
    store: sqliteRules,
    validateResource: ({ object }) =>
      (object.objectType === "settings" ||
        object.objectType === "permissions") &&
      object.objectId === "*",
  });
  const permissionAdministration = createPermissionAdministrationService({
    rules: createProdPermissionRuleStore(sqliteRules),
    contributions: createPermissionContributionStore(connection.database),
    authorize: async () => undefined,
  });
  const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
    textCommandPrefix: "",
    guildSettingsStore: store,
    labelTaxonomyStore: labelStore,
    supportHubDiscord: supportHub,
    ticketProvisioningService,
    ...(withPermissionSettings
      ? { permissionAdministration, permissionAuthorization }
      : {}),
  });
  return {
    connection,
    store,
    labelStore,
    supportHub,
    runtime,
    permissionAdministration,
  };
};

const guildRecord: Record<string, unknown> = {
  id: guildId,
  ownerId,
  client: { user: { id: "bot-1" } },
  roles: { cache: new Collection() },
};
guildRecord.members = {
  fetch: async (userId: string) => ({
    id: userId,
    guild: guildRecord,
    roles: {
      cache: {
        values: () => [{ id: guildId }][Symbol.iterator](),
      },
    },
    permissions: {
      has: (permission: string | bigint) =>
        userId === administratorId &&
        (permission === "Administrator" ||
          permission === PermissionFlagsBits.Administrator),
    },
  }),
};
const guild = guildRecord as unknown as Guild;

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
    modalValues?: Readonly<Record<string, string>>;
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
      getTextInputValue: (inputId: string) =>
        options.modalValues?.[inputId] ?? options.modalValue ?? "",
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

const labelModalRoute = (
  fieldId: "label-create" | "label-edit",
) => ({
  action: "modal-submit" as const,
  categoryId: "labels",
  subcategoryId: "labels",
  fieldId,
  page: 0,
});

const labelSelectRoute = {
  action: "string-select" as const,
  categoryId: "labels",
  subcategoryId: "labels",
  fieldId: "label-select",
  page: 0,
};

const labelDeleteRoute = {
  action: "button" as const,
  categoryId: "labels",
  subcategoryId: "labels",
  fieldId: "label-delete",
  page: 0,
};

describe("guild setup settings integration", () => {
  it("adds Manage Server roles to every permission preset on first reconciliation", async () => {
    const { runtime, permissionAdministration } = await setup({}, true);
    const bootstrapGuildId = "123456789012345690";
    const managerRoleId = "123456789012345691";
    const ordinaryRoleId = "123456789012345692";
    const botManagedRoleId = "123456789012345693";
    const bootstrapGuild = {
      id: bootstrapGuildId,
      ownerId,
      client: { user: { id: "bot-1" } },
      roles: {
        cache: new Collection([
          [
            bootstrapGuildId,
            {
              id: bootstrapGuildId,
              managed: false,
              permissions: permissions(PermissionFlagsBits.ManageGuild),
            },
          ],
          [
            managerRoleId,
            {
              id: managerRoleId,
              managed: false,
              permissions: permissions(PermissionFlagsBits.ManageGuild),
            },
          ],
          [
            ordinaryRoleId,
            {
              id: ordinaryRoleId,
              managed: false,
              permissions: permissions(),
            },
          ],
          [
            botManagedRoleId,
            {
              id: botManagedRoleId,
              managed: true,
              permissions: permissions(PermissionFlagsBits.ManageGuild),
            },
          ],
        ]),
      },
    } as unknown as Guild;
    const client = {
      guilds: {
        fetch: vi.fn(),
        cache: new Map([[bootstrapGuildId, bootstrapGuild]]),
      },
    } as unknown as Client<true>;

    await runtime.reconcile!(client);

    for (const preset of [
      "support_staff",
      "assignment_manager",
      "configurator",
    ] as const) {
      await expect(
        permissionAdministration.listPresetSubjects(bootstrapGuildId, preset),
      ).resolves.toEqual([
        { subjectType: "role", subjectId: managerRoleId },
      ]);
    }
  });

  it("renders direct Setup and Labels fields and nested Identity pages", async () => {
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

    const labelsCategory = component(
      "string",
      {
        action: "category",
        categoryId: "setup",
        subcategoryId: "setup",
        page: 0,
      },
      { selectedValues: ["labels"] },
    );
    await runtime.handleInteraction(labelsCategory as unknown as Interaction);
    const labelsPage = JSON.stringify(
      labelsCategory.editReply.mock.calls[0]?.[0],
    );
    expect(labelsPage).toContain(
      "Manage labels used to organize and assign tickets.",
    );
    expect(labelsPage).toContain("Current labels");
    expect(labelsPage).toContain("Select a label to manage it.");
    expect(labelsPage).toContain("Choose a label");
    expect(labelsPage).toContain("Create label");
    expect(labelsPage).not.toContain("## Create label");
    expect(labelsPage).toContain("# Current labels");
    expect(labelsPage).not.toContain("**Current:**");
    expect(labelsPage).toContain(
      '"content":"# Current labels"}],"accessory"',
    );
    expect(labelsPage.indexOf("# Current labels")).toBeLessThan(
      labelsPage.indexOf("**account:**"),
    );
    expect(labelsPage.indexOf("**account:**")).toBeLessThan(
      labelsPage.indexOf("Choose a label"),
    );
    expect(labelsPage).not.toContain("Add a label.");
    expect(labelsPage).not.toContain("Choose a settings page");
    expect(labelsPage).not.toContain("Ticket labels:");

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

  it("recovers a promoted hub transition without globally reasserting access", async () => {
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
      "Prod could not reconcile startup state",
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
    expect(ticketProvisioningService.resumeHubAccess).not.toHaveBeenCalled();
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

  it("refreshes the setup view after configuring the first hub with permission settings enabled", async () => {
    const { runtime, store } = await setup({}, true);
    const select = component("channel", hubRoute);

    await runtime.handleInteraction(select as unknown as Interaction);

    expect(await store.get(guildId)).toMatchObject({ hubChannelId });
    const response = JSON.stringify(select.editReply.mock.calls.at(-1)?.[0]);
    expect(response).not.toContain("could not refresh");
    expect(response).toContain("Support channel");
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

  it("seeds generic labels when authorized settings are opened", async () => {
    const { runtime, labelStore } = await setup();

    await runtime.handleInteraction(
      command(administratorId, [
        PermissionFlagsBits.Administrator,
      ]) as unknown as Interaction,
    );

    await expect(labelStore.list(guildId)).resolves.toEqual([
      expect.objectContaining({ name: "account" }),
      expect.objectContaining({ name: "bug" }),
      expect.objectContaining({ name: "feedback" }),
      expect.objectContaining({ name: "gameplay" }),
      expect.objectContaining({ name: "other" }),
    ]);
  });

  it("creates, selects, edits, and deletes labels with persisted rerenders", async () => {
    const { connection, runtime, labelStore } = await setup();
    await labelStore.ensureDefaults(guildId);

    const create = component("modal", labelModalRoute("label-create"), {
      modalValues: {
        name: "Connection Issue",
        description: "",
      },
    });
    await runtime.handleInteraction(create as unknown as Interaction);
    expect(JSON.stringify(create.editReply.mock.calls[0]?.[0])).toContain(
      "Connection Issue",
    );
    await expect(
      labelStore.findByName(guildId, "connection issue"),
    ).resolves.not.toHaveProperty("description");

    const duplicate = component("modal", labelModalRoute("label-create"), {
      modalValues: {
        name: "  ＣＯＮＮＥＣＴＩＯＮ   ISSUE ",
        description: "A normalized duplicate.",
      },
    });
    await runtime.handleInteraction(duplicate as unknown as Interaction);
    expect(JSON.stringify(duplicate.editReply.mock.calls[0]?.[0])).toContain(
      "already exists",
    );

    const edit = component("modal", labelModalRoute("label-edit"), {
      modalValues: {
        name: "Connectivity",
        description: "Network and game-server connectivity problems.",
      },
    });
    await runtime.handleInteraction(edit as unknown as Interaction);
    expect(JSON.stringify(edit.editReply.mock.calls[0]?.[0])).toContain(
      "Connectivity",
    );

    const firstDelete = component("button", labelDeleteRoute);
    await runtime.handleInteraction(firstDelete as unknown as Interaction);
    expect(JSON.stringify(firstDelete.editReply.mock.calls[0]?.[0])).toContain(
      "Confirm delete",
    );

    const confirmDelete = component("button", labelDeleteRoute);
    await runtime.handleInteraction(confirmDelete as unknown as Interaction);
    expect(
      JSON.stringify(confirmDelete.editReply.mock.calls[0]?.[0]),
    ).not.toContain("Connectivity");

    await expect(
      labelStore.findByName(guildId, "connectivity"),
    ).resolves.toBeUndefined();
    const restarted = createSqliteLabelTaxonomyStore(connection.database);
    await expect(
      restarted.findByName(guildId, "connectivity"),
    ).resolves.toBeUndefined();
  });

  it("appends management controls for the selected label", async () => {
    const { runtime, labelStore } = await setup();
    await labelStore.ensureDefaults(guildId);
    const bug = (await labelStore.findByName(guildId, "bug"))!;
    const select = component("string", labelSelectRoute, {
      selectedValues: [bug.id],
    });

    await runtime.handleInteraction(select as unknown as Interaction);

    const payload = JSON.stringify(select.editReply.mock.calls[0]?.[0]);
    expect(payload).toContain("Unexpected behavior, errors, crashes");
    expect(payload).toContain('"label":"Edit"');
    expect(payload).toContain('"label":"Delete"');
    expect(payload).not.toContain("## Edit label");
    expect(payload).not.toContain("## Delete label");
    expect(payload.indexOf("**account:**")).toBeLessThan(
      payload.indexOf("Choose a label"),
    );
  });

  it("keeps label creation available when the taxonomy is empty", async () => {
    const { runtime, labelStore } = await setup();
    await labelStore.ensureDefaults(guildId);
    for (const label of await labelStore.list(guildId)) {
      await labelStore.delete(guildId, label.id);
    }
    const labelsCategory = component(
      "string",
      {
        action: "category",
        categoryId: "setup",
        subcategoryId: "setup",
        page: 0,
      },
      { selectedValues: ["labels"] },
    );

    await runtime.handleInteraction(labelsCategory as unknown as Interaction);

    const payload = JSON.stringify(labelsCategory.editReply.mock.calls[0]?.[0]);
    expect(payload).toContain("Current labels");
    expect(payload).toContain("Create label");
    expect(payload).not.toContain("## Create label");
    expect(payload).toContain("# Current labels");
    expect(payload).not.toContain("Add a label.");
    expect(payload).not.toContain("Choose a label");
  });

  it("rechecks authorization before a label mutation", async () => {
    const { runtime, store, labelStore } = await setup();
    await store.configureHub(guildId, hubChannelId, ownership());
    await labelStore.ensureDefaults(guildId);
    const bug = (await labelStore.findByName(guildId, "bug"))!;
    const select = component("string", labelSelectRoute, {
      selectedValues: [bug.id],
    });
    await runtime.handleInteraction(select as unknown as Interaction);
    const unauthorized = component(
      "button",
      labelDeleteRoute,
      {
        userId: "ordinary-member",
        allowed: [],
      },
    );

    await runtime.handleInteraction(unauthorized as unknown as Interaction);

    expect(unauthorized.editReply).not.toHaveBeenCalled();
    expect(unauthorized.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Manage Server permission or bot operator access is required for settings.",
        flags: MessageFlags.Ephemeral,
      }),
    );
    await expect(labelStore.findByName(guildId, "bug")).resolves.toMatchObject(
      { id: bug.id },
    );
  });

  it("keeps every supported label reachable within the Discord select", async () => {
    const { runtime, labelStore } = await setup();
    await labelStore.ensureDefaults(guildId);
    const customNames: string[] = [];
    for (let index = 0; index < MAX_LABELS - 5; index++) {
      const name = `${String(index).padStart(2, "0")}-${"*".repeat(77)}`;
      customNames.push(name);
      await labelStore.create(guildId, {
        name,
        description: "x".repeat(500),
      });
    }

    const selected = (await labelStore.findByName(
      guildId,
      customNames.at(-1)!,
    ))!;
    const select = component("string", labelSelectRoute, {
      selectedValues: [selected.id],
    });
    await runtime.handleInteraction(select as unknown as Interaction);

    const edit = component("modal", labelModalRoute("label-edit"), {
      modalValues: {
        name: customNames.at(-1)!.replace("19-", "zz-"),
        description: "Updated at the supported boundary.",
      },
    });
    await runtime.handleInteraction(edit as unknown as Interaction);
    const payload = JSON.stringify(edit.editReply.mock.calls[0]?.[0]);

    for (let index = 0; index < customNames.length - 1; index++) {
      expect(payload).toContain(`${String(index).padStart(2, "0")}-`);
    }
    expect(payload).toContain("zz-");

    const overflow = component("modal", labelModalRoute("label-create"), {
      modalValues: {
        name: "overflow",
        description: "This exceeds the supported label bound.",
      },
    });
    await runtime.handleInteraction(overflow as unknown as Interaction);
    expect(JSON.stringify(overflow.editReply.mock.calls[0]?.[0])).toContain(
      "at most 25 labels",
    );
  });
});
