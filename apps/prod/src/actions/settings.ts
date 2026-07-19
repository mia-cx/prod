import {
  ChannelType,
  PermissionFlagsBits,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
} from "discord.js";
import type { Logger } from "pino";
import {
  createSettingsRuntime,
  type SettingsDefinition,
  type SettingsDispatchResult,
  type SettingsMutationResult,
  type SettingsValidationIssue,
} from "@protocord/settings";
import type {
  AuthorizationService,
  UserAuthorizationSubject,
} from "@protocord/permissions";
import { slashCommand, type Action } from "protocord";

import type {
  GuildSettingsStore,
  GuildSetupSettings,
} from "../guild-settings.js";
import { createGuildSetupService } from "../guild-setup.js";
import type { ExecuteGuildOperation } from "../guild-operation.js";
import type { PermissionAdministrationService } from "../permission-administration.js";
import { createProdAuthorizationContext } from "../authorization.js";
import type { SupportHubDiscord } from "../support-hub.js";
import type { TicketProvisioningService } from "../ticket-provisioning.js";
import { createPermissionSettingsCategory } from "./permission-settings.js";
import type { ProdActionContext } from "./runtime.js";

type GuildSetupSettingsContext = Readonly<{
  userId: string;
  guildId?: string;
  isGuildOwner: boolean;
  isAdministrator: boolean;
  canManageGuild: boolean;
  isApplicationOperator: boolean;
  settingsSessionId: string;
  guild?: Guild;
}>;

export type PermissionSettingsDependencies = Readonly<{
  administration: PermissionAdministrationService;
  authorization: AuthorizationService;
  createUserAuthorizationSubject: ProdActionContext["createUserAuthorizationSubject"];
}>;

export type GuildSetupSettingsConsumer = Readonly<{
  action: Action<
    Readonly<Record<never, never>>,
    SettingsDispatchResult,
    ProdActionContext
  >;
  handle(interaction: Interaction): Promise<SettingsDispatchResult>;
  reconcile(guild: Guild): Promise<GuildSetupSettings>;
}>;

const invalid = (
  issues: readonly SettingsValidationIssue[],
): SettingsMutationResult => ({
  status: "invalid",
  issues,
});

const issue = (message: string): SettingsValidationIssue => ({ message });

const requireGuild = (context: GuildSetupSettingsContext): Guild => {
  if (context.guild === undefined) {
    throw new TypeError("Guild settings require a guild interaction");
  }
  return context.guild;
};

export function createGuildSetupSettingsConsumer(
  logger: Logger,
  isApplicationOperator: (userId: string) => boolean,
  store: GuildSettingsStore,
  supportHub: SupportHubDiscord,
  ticketProvisioning: TicketProvisioningService,
  executeGuildOperation?: ExecuteGuildOperation,
  permissionSettings?: PermissionSettingsDependencies,
): GuildSetupSettingsConsumer {
  const setup = createGuildSetupService(
    store,
    supportHub,
    ticketProvisioning,
    executeGuildOperation,
  );
  const permissionInitializations = new Map<string, Promise<void>>();
  const initializePermissions = async (guild: Guild): Promise<void> => {
    if (permissionSettings === undefined) return;
    const active = permissionInitializations.get(guild.id);
    if (active !== undefined) return active;
    const initialization = (async () => {
      if (await permissionSettings.administration.hasGuildRecords(guild.id)) {
        return;
      }
      const subjects = [...guild.roles.cache.values()]
        .filter(
          (role) =>
            role.id !== guild.id &&
            role.permissions.has(PermissionFlagsBits.ManageGuild),
        )
        .map((role) => ({
          subjectType: "role" as const,
          subjectId: role.id,
        }));
      if (subjects.length === 0) return;
      await permissionSettings.administration.initializePresetsIfEmpty({
        guildId: guild.id,
        subjects,
        actorUserId:
          guild.client.user?.id ?? "system:guild-permission-bootstrap",
      });
    })();
    permissionInitializations.set(guild.id, initialization);
    try {
      await initialization;
    } finally {
      permissionInitializations.delete(guild.id);
    }
  };
  const authorizeSetup = async (context: GuildSetupSettingsContext) => {
    if (context.guild === undefined) {
      return {
        authorized: false as const,
        reason: "Settings are available only inside a server.",
      };
    }
    const state = await setup.get(context.guild);
    const isBootstrapAdministrator =
      context.isGuildOwner || context.isAdministrator;
    if (state.hubChannelId === undefined && !isBootstrapAdministrator) {
      return {
        authorized: false as const,
        reason:
          "Only the server owner or an administrator can configure the first support hub.",
      };
    }
    if (state.hubChannelId !== undefined && permissionSettings !== undefined) {
      try {
        const decision = await permissionDecision(
          context,
          permissionSettings,
          "settings",
        );
        return decision.allowed
          ? { authorized: true as const }
          : {
              authorized: false as const,
              reason: "Settings management access is required.",
            };
      } catch {
        return {
          authorized: false as const,
          reason: "Settings management access could not be verified.",
        };
      }
    }
    return isBootstrapAdministrator ||
      context.canManageGuild ||
      context.isApplicationOperator
      ? { authorized: true as const }
      : {
          authorized: false as const,
          reason:
            "Manage Server permission or bot operator access is required for settings.",
        };
  };

  const definition: SettingsDefinition<GuildSetupSettingsContext> = {
    title: "Settings",
    accentColor: 0x5865f2,
    categories: [
      {
        id: "setup",
        label: "Setup",
        description: "Configure basic setup for Prod.",
        authorize: authorizeSetup,
        fields: [
          {
            kind: "channel-select",
            id: "hub-channel",
            label: "Support channel",
            description: "Choose where Prod manages support threads.",
            load: async (context) => {
              const state = await setup.get(requireGuild(context));
              return {
                channelTypes: [ChannelType.GuildText],
                minValues: 1,
                maxValues: 1,
                ...(state.hubChannelId === undefined
                  ? {}
                  : { defaultChannelIds: [state.hubChannelId] }),
              };
            },
            validate: async (values, context) => {
              const selected = values[0];
              if (selected === undefined) {
                return [issue("Select one support channel.")];
              }
              const result = await setup.validateHub(
                requireGuild(context),
                selected.id,
              );
              return result.valid ? [] : result.issues.map(issue);
            },
            mutate: async (values, context) => {
              const selected = values[0];
              if (selected === undefined) {
                return invalid([issue("Select one support channel.")]);
              }
              const guild = requireGuild(context);
              const result = await setup.configureHub(guild, selected.id);
              if (!result.valid) return invalid(result.issues.map(issue));
              return { status: "success" as const };
            },
          },
        ],
      },
      {
        id: "identity",
        label: "Identity",
        description: "Configure Prod's personality and knowledge.",
        authorize: authorizeSetup,
        subcategories: [
          {
            id: "personality",
            label: "Personality",
            description: "Configure how Prod communicates with users.",
            fields: [
              {
                kind: "modal",
                id: "assistant-system-prompt",
                label: "Role",
                title: "Edit role",
                presentation: { kind: "preview", maxLength: 300 },
                inputs: [
                  {
                    id: "system-prompt",
                    label: "Role",
                    style: TextInputStyle.Paragraph,
                    minLength: 3,
                  },
                ],
                load: async (context) => {
                  const value = (await setup.get(requireGuild(context)))
                    .systemPrompt;
                  return {
                    value,
                    values: { "system-prompt": value },
                    buttonLabel: "Edit",
                  };
                },
                validate: (values) =>
                  (values["system-prompt"]?.trim().length ?? 0) < 3
                    ? [
                        {
                          inputId: "system-prompt",
                          message: "Use at least three visible characters.",
                        },
                      ]
                    : [],
                mutate: async (values, context) => {
                  await setup.setSystemPrompt(
                    requireGuild(context),
                    values["system-prompt"]!,
                  );
                },
              },
              {
                kind: "modal",
                id: "assistant-product",
                label: "Product knowledge",
                title: "Edit product knowledge",
                presentation: { kind: "preview", maxLength: 300 },
                inputs: [
                  {
                    id: "product-knowledge",
                    label: "Product knowledge",
                    style: TextInputStyle.Paragraph,
                    minLength: 3,
                  },
                ],
                load: async (context) => {
                  const value = (await setup.get(requireGuild(context)))
                    .productKnowledgePrompt;
                  return {
                    value,
                    values: { "product-knowledge": value },
                    buttonLabel: "Edit",
                  };
                },
                validate: (values) =>
                  (values["product-knowledge"]?.trim().length ?? 0) < 3
                    ? [
                        {
                          inputId: "product-knowledge",
                          message: "Use at least three visible characters.",
                        },
                      ]
                    : [],
                mutate: async (values, context) => {
                  await setup.setProductKnowledgePrompt(
                    requireGuild(context),
                    values["product-knowledge"]!,
                  );
                },
              },
              {
                kind: "modal",
                id: "assistant-workflow",
                label: "Support workflow",
                title: "Edit support workflow",
                presentation: { kind: "preview", maxLength: 300 },
                inputs: [
                  {
                    id: "support-workflow",
                    label: "Support workflow",
                    style: TextInputStyle.Paragraph,
                    minLength: 3,
                  },
                ],
                load: async (context) => {
                  const value = (await setup.get(requireGuild(context)))
                    .supportWorkflowPrompt;
                  return {
                    value,
                    values: { "support-workflow": value },
                    buttonLabel: "Edit",
                  };
                },
                validate: (values) =>
                  (values["support-workflow"]?.trim().length ?? 0) < 3
                    ? [
                        {
                          inputId: "support-workflow",
                          message: "Use at least three visible characters.",
                        },
                      ]
                    : [],
                mutate: async (values, context) => {
                  await setup.setSupportWorkflowPrompt(
                    requireGuild(context),
                    values["support-workflow"]!,
                  );
                },
              },
              {
                kind: "modal",
                id: "assistant-safety",
                label: "Safety",
                title: "Edit safety",
                presentation: { kind: "preview", maxLength: 300 },
                inputs: [
                  {
                    id: "safety",
                    label: "Safety",
                    style: TextInputStyle.Paragraph,
                    minLength: 3,
                  },
                ],
                load: async (context) => {
                  const value = (await setup.get(requireGuild(context)))
                    .safetyPrompt;
                  return {
                    value,
                    values: { safety: value },
                    buttonLabel: "Edit",
                  };
                },
                validate: (values) =>
                  (values.safety?.trim().length ?? 0) < 3
                    ? [
                        {
                          inputId: "safety",
                          message: "Use at least three visible characters.",
                        },
                      ]
                    : [],
                mutate: async (values, context) => {
                  await setup.setSafetyPrompt(
                    requireGuild(context),
                    values.safety!,
                  );
                },
              },
              {
                kind: "modal",
                id: "assistant-style-prompt",
                label: "Style prompt",
                title: "Edit style prompt",
                presentation: { kind: "preview", maxLength: 300 },
                inputs: [
                  {
                    id: "tone",
                    label: "Style prompt",
                    style: TextInputStyle.Paragraph,
                    placeholder: "friendly, patient, and concise",
                    minLength: 3,
                  },
                ],
                load: async (context) => {
                  const value = (await setup.get(requireGuild(context))).tone;
                  return {
                    value,
                    values: { tone: value },
                    buttonLabel: "Edit",
                  };
                },
                validate: (values) =>
                  (values.tone?.trim().length ?? 0) < 3
                    ? [
                        {
                          inputId: "tone",
                          message: "Use at least three visible characters.",
                        },
                      ]
                    : [],
                mutate: async (values, context) => {
                  await setup.setTone(requireGuild(context), values.tone!);
                },
              },
            ],
          },
          {
            id: "knowledge-base",
            label: "Knowledge base",
            description: "Manage reusable fixes Prod can suggest to users.",
            fields: [],
          },
        ],
      },
      ...(permissionSettings === undefined
        ? []
        : [
            createPermissionSettingsCategory<GuildSetupSettingsContext>({
              service: permissionSettings.administration,
              authorize: async (context) => {
                try {
                  const decision = await permissionDecision(
                    context,
                    permissionSettings,
                  );
                  return decision.allowed
                    ? { authorized: true as const }
                    : {
                        authorized: false as const,
                        reason:
                          "Permission management access is required for this category.",
                      };
                } catch {
                  return {
                    authorized: false as const,
                    reason:
                      "Permission management access could not be verified.",
                  };
                }
              },
              requireAuthorization: async (context) => {
                const input = await permissionCheck(
                  context,
                  permissionSettings,
                );
                await permissionSettings.authorization.require(input);
              },
            }),
          ]),
    ],
  };

  const runtime = createSettingsRuntime({
    definition,
    onError: (error) => {
      logger.error({ err: error }, "guild setup settings interaction failed");
    },
  });
  const action: GuildSetupSettingsConsumer["action"] = {
    name: "open_settings",
    description: "Configure Prod for this server.",
    input: {
      parse: (input) => {
        if (!input || typeof input !== "object") {
          throw new TypeError("Settings input must be an object");
        }
        return {};
      },
      jsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    triggers: [
      slashCommand({
        name: "settings",
        description: "Configure Prod for this server",
        parse: () => ({}),
        present: async () => undefined,
      }),
    ],
    availability: () => ({ available: true }),
    authorization: () => undefined,
    execute: async (invocation) => {
      const interaction = invocation.rawEvent as ChatInputCommandInteraction;
      if (interaction.guild !== null) {
        await initializePermissions(interaction.guild);
      }
      return runtime.open(
        interaction,
        settingsContext(interaction, isApplicationOperator),
      );
    },
  };

  return Object.freeze({
    action,
    reconcile: async (guild: Guild) => {
      await initializePermissions(guild);
      return setup.get(guild);
    },
    handle: async (interaction) => {
      if (interaction.guild !== null) {
        await initializePermissions(interaction.guild);
      }
      return runtime.handle(
        interaction,
        settingsContext(interaction, isApplicationOperator),
      );
    },
  });
}

function settingsContext(
  interaction: Interaction,
  isApplicationOperator: (userId: string) => boolean,
): GuildSetupSettingsContext {
  const guild = interaction.guild ?? undefined;
  return {
    userId: interaction.user.id,
    settingsSessionId:
      "message" in interaction && interaction.message !== null
        ? interaction.message.id
        : interaction.id,
    ...(interaction.guildId === null ? {} : { guildId: interaction.guildId }),
    isGuildOwner: guild?.ownerId === interaction.user.id,
    isAdministrator:
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ??
      false,
    canManageGuild:
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ??
      false,
    isApplicationOperator: isApplicationOperator(interaction.user.id),
    ...(guild === undefined ? {} : { guild }),
  };
}

async function permissionCheck(
  context: GuildSetupSettingsContext,
  dependencies: PermissionSettingsDependencies,
  objectType: "settings" | "permissions" = "permissions",
): Promise<Parameters<AuthorizationService["check"]>[0]> {
  const guild = requireGuild(context);
  const member = await guild.members.fetch(context.userId);
  const authorizationContext = createProdAuthorizationContext(guild.id);
  const subject: UserAuthorizationSubject =
    dependencies.createUserAuthorizationSubject(member, authorizationContext);
  return {
    context: authorizationContext,
    subject,
    object: { objectType, objectId: "*" },
    verb: "manage",
  };
}

async function permissionDecision(
  context: GuildSetupSettingsContext,
  dependencies: PermissionSettingsDependencies,
  objectType: "settings" | "permissions" = "permissions",
) {
  return dependencies.authorization.check(
    await permissionCheck(context, dependencies, objectType),
  );
}
