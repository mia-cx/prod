import {
  ChannelType,
  PermissionFlagsBits,
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
import { slashCommand, type Action } from "protocord";

import type { GuildSettingsStore } from "../guild-settings.js";
import { createGuildSetupService } from "../guild-setup.js";
import type { SupportHubDiscord } from "../support-hub.js";
import type { TicketProvisioningService } from "../ticket-provisioning.js";
import type { ProdActionContext } from "./runtime.js";

type GuildSetupSettingsContext = Readonly<{
  userId: string;
  isGuildOwner: boolean;
  isAdministrator: boolean;
  canManageGuild: boolean;
  isApplicationOperator: boolean;
  guild?: Guild;
}>;

export type GuildSetupSettingsConsumer = Readonly<{
  action: Action<
    Readonly<Record<never, never>>,
    SettingsDispatchResult,
    ProdActionContext
  >;
  handle(interaction: Interaction): Promise<SettingsDispatchResult>;
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
): GuildSetupSettingsConsumer {
  const setup = createGuildSetupService(store, supportHub, ticketProvisioning);
  const authorize = async (context: GuildSetupSettingsContext) => {
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
    title: "Prod settings",
    accentColor: 0x5865f2,
    categories: [
      {
        id: "setup",
        label: "Setup",
        description:
          "Configure this server's private support hub and assistant.",
        authorize,
        subcategories: [
          {
            id: "hub",
            label: "Support hub",
            description:
              "Choose the locked text channel that owns private support threads.",
            fields: [
              {
                kind: "channel-select",
                id: "hub-channel",
                label: "Support hub channel",
                description:
                  "Prod validates its effective permissions before applying the empty-hub privacy boundary.",
                load: async (context) => {
                  const state = await setup.get(requireGuild(context));
                  return {
                    value:
                      state.hubChannelId === undefined
                        ? "Not configured"
                        : `<#${state.hubChannelId}>`,
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
                    return [issue("Select one support hub text channel.")];
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
                    return invalid([
                      issue("Select one support hub text channel."),
                    ]);
                  }
                  const guild = requireGuild(context);
                  const result = await setup.configureHub(guild, selected.id);
                  if (!result.valid) return invalid(result.issues.map(issue));
                  return { status: "success" as const };
                },
              },
              {
                kind: "button",
                id: "hub-information",
                label: "Hub information message",
                description:
                  "Post the support instructions once, or refresh the existing bot-managed message.",
                load: async (context) => {
                  const state = await setup.get(requireGuild(context));
                  return {
                    value:
                      state.hubInformationMessageId === undefined
                        ? "Not posted"
                        : `[Open message](https://discord.com/channels/${state.guildId}/${state.hubChannelId!}/${state.hubInformationMessageId})`,
                    buttonLabel:
                      state.hubInformationMessageId === undefined
                        ? "Post information"
                        : "Refresh information",
                    disabled: state.hubChannelId === undefined,
                  };
                },
                mutate: async (context) => {
                  const guild = requireGuild(context);
                  const configured =
                    await setup.refreshInformationMessage(guild);
                  if (!configured.valid) {
                    return invalid(configured.issues.map(issue));
                  }
                  return { status: "success" as const };
                },
              },
              {
                kind: "display",
                id: "privacy",
                label: "Empty-hub privacy",
                load: () => ({
                  value:
                    "Reporters cannot send hub messages, send in threads, or create public/private threads. Ticket provisioning grants private-thread participation per reporter.",
                }),
              },
            ],
          },
          {
            id: "assistant",
            label: "Assistant",
            description:
              "Configure the identity and tone used in support messages.",
            fields: [
              {
                kind: "modal",
                id: "assistant-identity",
                label: "Assistant identity",
                title: "Edit assistant identity",
                inputs: [
                  {
                    id: "identity",
                    label: "Display identity",
                    placeholder: "Prod",
                    minLength: 2,
                    maxLength: 32,
                  },
                ],
                load: async (context) => {
                  const value = (await setup.get(requireGuild(context)))
                    .assistantIdentity;
                  return {
                    value,
                    values: { identity: value },
                    buttonLabel: "Edit",
                  };
                },
                validate: (values) =>
                  (values.identity?.trim().length ?? 0) < 2
                    ? [
                        {
                          inputId: "identity",
                          message: "Use at least two visible characters.",
                        },
                      ]
                    : [],
                mutate: async (values, context) => {
                  await setup.setAssistantIdentity(
                    requireGuild(context),
                    values.identity!,
                  );
                },
              },
              {
                kind: "modal",
                id: "assistant-tone",
                label: "Assistant tone",
                title: "Edit assistant tone",
                inputs: [
                  {
                    id: "tone",
                    label: "Tone instruction",
                    placeholder: "friendly, patient, and concise",
                    minLength: 3,
                    maxLength: 500,
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
        ],
      },
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
      return runtime.open(
        interaction,
        settingsContext(interaction, isApplicationOperator),
      );
    },
  };

  return Object.freeze({
    action,
    handle: (interaction) =>
      runtime.handle(
        interaction,
        settingsContext(interaction, isApplicationOperator),
      ),
  });
}

function settingsContext(
  interaction: Interaction,
  isApplicationOperator: (userId: string) => boolean,
): GuildSetupSettingsContext {
  const guild = interaction.guild ?? undefined;
  return {
    userId: interaction.user.id,
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
