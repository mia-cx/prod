import {
  Collection,
  MessageFlags,
  PermissionFlagsBits,
  type Guild,
  type Interaction,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSqlitePermissionRuleStore,
  type DiscordMemberLike,
} from "@protocord/permissions";
import { encodeSettingsCustomId } from "@protocord/settings";

import { createProdActionRuntime } from "../src/actions/runtime.js";
import {
  createProdAuthorizationService,
  createProdPermissionRuleStore,
} from "../src/authorization.js";
import { openDatabase, type DatabaseConnection } from "../src/database.js";
import type { GuildSettingsStore } from "../src/guild-settings.js";
import type { HubPermissionOwnership } from "../src/hub-permission-ownership.js";
import { createLogger } from "../src/logger.js";
import { applyMigrations } from "../src/migrations.js";
import { createPermissionAdministrationService } from "../src/permission-administration.js";
import { createPermissionContributionStore } from "../src/permission-contribution-store.js";
import type { SupportHubDiscord } from "../src/support-hub.js";

const guildId = "123456789012345670";
const managerId = "123456789012345671";
const configuratorRoleId = "123456789012345672";
const targetUserId = "123456789012345673";
const targetRoleId = "123456789012345674";

const connections: DatabaseConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

const ownership: HubPermissionOwnership = {
  version: 1,
  channelId: "123456789012345699",
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
  get: async (id) => ({
    guildId: id,
    initialized: true,
    hubChannelId: ownership.channelId,
    hubPermissionOwnership: ownership,
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
  validateHub: async () => ({ valid: true }),
  prepareHub: async () => ({ valid: true, permissionOwnership: ownership }),
  applyHub: async () => ({ valid: true, permissionOwnership: ownership }),
  restoreHub: async () => undefined,
  releaseHub: async () => undefined,
  releaseFormerHub: async () => undefined,
  upsertInformationMessage: async () => "message-1",
  deleteInformationMessage: async () => undefined,
};

describe("permission settings integration", () => {
  it("uses current Discord roles for every view and mutation recheck", async () => {
    const connection = openDatabase(":memory:");
    connections.push(connection);
    await applyMigrations(connection.database);
    const sqliteRules = createSqlitePermissionRuleStore(connection.database);
    const permissionAuthorization = createProdAuthorizationService({
      store: sqliteRules,
      validateResource: ({ object }) =>
        (object.objectType === "settings" ||
          object.objectType === "permissions") &&
        object.objectId === "*",
    });
    const seedAuthorization = vi.fn(async () => undefined);
    const administration = createPermissionAdministrationService({
      rules: createProdPermissionRuleStore(sqliteRules),
      contributions: createPermissionContributionStore(connection.database),
      authorize: seedAuthorization,
    });

    const roleIds = new Set([guildId, configuratorRoleId]);
    const guildRecord: Record<string, unknown> = {
      id: guildId,
      ownerId: managerId,
    };
    const member: DiscordMemberLike = {
      id: managerId,
      guild: guildRecord as DiscordMemberLike["guild"],
      roles: {
        cache: {
          values: () => [...roleIds].map((id) => ({ id }))[Symbol.iterator](),
        },
      },
      permissions: { has: () => false },
    };
    const fetchMember = vi.fn(async () => member);
    guildRecord.members = { fetch: fetchMember };
    const guild = guildRecord as unknown as Guild;

    const runtime = createProdActionRuntime(createLogger({ level: "fatal" }), {
      textCommandPrefix: "",
      guildSettingsStore,
      supportHubDiscord,
      permissionAdministration: administration,
      permissionAuthorization,
    });
    const command = commandInteraction(guild);
    await runtime.handleInteraction(command as unknown as Interaction);
    expect(command.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.IsComponentsV2 }),
    );
    expect(JSON.stringify(command.editReply.mock.calls[0]?.[0])).toContain(
      "Permissions",
    );

    guildRecord.ownerId = "123456789012345698";
    const revokedBootstrap = mentionableInteraction(guild, "configurator", [
      configuratorRoleId,
    ]);
    revokedBootstrap.memberPermissions = {
      has: (permission: unknown) =>
        permission === PermissionFlagsBits.Administrator,
    };
    await runtime.handleInteraction(revokedBootstrap as unknown as Interaction);
    await expect(
      administration.listPresetSubjects(guildId, "configurator"),
    ).resolves.toEqual([]);

    await administration.applyCustomRules({
      guildId,
      subjects: [{ subjectType: "user", subjectId: targetUserId }],
      scope: "guild",
      object: { objectType: "permissions", objectId: "*" },
      verbs: ["manage"],
      permit: "deny",
      actorUserId: "seed-admin",
    });
    guildRecord.ownerId = managerId;
    const bootstrap = mentionableInteraction(guild, "configurator", [
      configuratorRoleId,
    ]);
    await runtime.handleInteraction(bootstrap as unknown as Interaction);
    await expect(
      administration.listPresetSubjects(guildId, "configurator"),
    ).resolves.toEqual([
      { subjectType: "role", subjectId: configuratorRoleId },
    ]);
    guildRecord.ownerId = "123456789012345698";

    const fetchesBeforeMutation = fetchMember.mock.calls.length;
    const supportStaff = mentionableInteraction(guild, "support_staff", [
      targetUserId,
      targetRoleId,
    ]);
    await runtime.handleInteraction(supportStaff as unknown as Interaction);
    await expect(
      administration.listPresetSubjects(guildId, "support_staff"),
    ).resolves.toEqual([
      { subjectType: "role", subjectId: targetRoleId },
      { subjectType: "user", subjectId: targetUserId },
    ]);
    expect(fetchMember.mock.calls.length).toBeGreaterThan(
      fetchesBeforeMutation,
    );

    roleIds.delete(configuratorRoleId);
    const assignmentManager = mentionableInteraction(
      guild,
      "assignment_manager",
      [targetRoleId],
    );
    await runtime.handleInteraction(
      assignmentManager as unknown as Interaction,
    );
    await expect(
      administration.listPresetSubjects(guildId, "assignment_manager"),
    ).resolves.toEqual([]);
    expect(assignmentManager.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Permission management access is required for this category.",
        flags: MessageFlags.Ephemeral,
      }),
    );
  });
});

const baseInteraction = (guild: Guild) => ({
  guild,
  guildId,
  user: { id: managerId, username: "manager", globalName: "Manager" },
  memberPermissions: { has: () => false },
  deferred: false,
  replied: false,
  isAutocomplete: () => false,
  isMessageContextMenuCommand: () => false,
  isUserContextMenuCommand: () => false,
  isButton: () => false,
  isStringSelectMenu: () => false,
  isChannelSelectMenu: () => false,
  isModalSubmit: () => false,
});

const commandInteraction = (guild: Guild) => {
  const interaction: Record<string, unknown> = {
    ...baseInteraction(guild),
    commandName: "settings",
    isChatInputCommand: () => true,
    isMentionableSelectMenu: () => false,
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
  };
};

const mentionableInteraction = (
  guild: Guild,
  preset: "support_staff" | "assignment_manager" | "configurator",
  values: readonly string[],
) => {
  const users = new Collection();
  users.set(targetUserId, {
    id: targetUserId,
    username: "target",
    globalName: "Target",
  });
  const roles = new Collection();
  roles.set(targetRoleId, { id: targetRoleId, name: "Target role" });
  roles.set(configuratorRoleId, {
    id: configuratorRoleId,
    name: "Configurator",
  });
  const interaction: Record<string, unknown> = {
    ...baseInteraction(guild),
    customId: encodeSettingsCustomId({
      action: "mentionable-select",
      categoryId: "permissions",
      subcategoryId: preset,
      fieldId: "add",
      page: 0,
    }),
    values,
    users,
    roles,
    message: { id: "settings-message" },
    isFromMessage: () => true,
    isChatInputCommand: () => false,
    isMentionableSelectMenu: () => true,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
  };
  return interaction as typeof interaction & {
    followUp: ReturnType<typeof vi.fn>;
  };
};
