import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Interaction,
} from "discord.js";
import type { Logger } from "pino";
import {
  createSettingsRuntime,
  type SettingsDefinition,
  type SettingsDispatchResult,
  type SettingsMentionableReference,
} from "@protocord/settings";
import { slashCommand, type Action } from "protocord";

import type { ProdActionContext } from "./runtime.js";

type SyntheticSettingsContext = Readonly<{
  guildId?: string;
  userId: string;
  canManageGuild: boolean;
}>;

type SyntheticGuildSettings = {
  refreshCount: number;
  tone: string;
  staff: readonly SettingsMentionableReference[];
  hubChannelId?: string;
  assistantName: string;
};

export type SyntheticSettingsConsumer = Readonly<{
  action: Action<
    Readonly<Record<never, never>>,
    SettingsDispatchResult,
    ProdActionContext
  >;
  handle(interaction: Interaction): Promise<SettingsDispatchResult>;
}>;

export function createSyntheticSettingsConsumer(
  logger: Logger,
): SyntheticSettingsConsumer {
  const stateByGuild = new Map<string, SyntheticGuildSettings>();
  const loadState = (context: SyntheticSettingsContext): SyntheticGuildSettings => {
    const guildId = context.guildId ?? "direct-message";
    const existing = stateByGuild.get(guildId);
    if (existing !== undefined) {
      return existing;
    }
    const created: SyntheticGuildSettings = {
      refreshCount: 0,
      tone: "friendly",
      staff: [],
      assistantName: "Prod",
    };
    stateByGuild.set(guildId, created);
    return created;
  };
  const authorize = (context: SyntheticSettingsContext) =>
    context.guildId !== undefined && context.canManageGuild
      ? { authorized: true as const }
      : {
          authorized: false as const,
          reason: "Manage Server permission is required for settings.",
        };

  const definition: SettingsDefinition<SyntheticSettingsContext> = {
    title: "Prod development settings",
    accentColor: 0x5865f2,
    categories: [
      {
        id: "controls",
        label: "Controls",
        description: "Exercise every interactive settings field.",
        authorize,
        subcategories: [
          {
            id: "general",
            label: "General",
            description: "Synthetic state is held in memory per development guild.",
            fields: [
              {
                kind: "button",
                id: "refresh",
                label: "Refresh information",
                description: "Exercise a button mutation and rerender.",
                load: (context) => ({
                  value: `${String(loadState(context).refreshCount)} refreshes`,
                  buttonLabel: "Refresh",
                }),
                mutate: (context) => {
                  loadState(context).refreshCount += 1;
                  return { status: "success", message: "Information refreshed." };
                },
              },
              {
                kind: "string-select",
                id: "tone",
                label: "Assistant tone",
                load: (context) => ({
                  value: loadState(context).tone,
                  selectedValues: [loadState(context).tone],
                  options: [
                    { label: "Friendly", value: "friendly" },
                    { label: "Direct", value: "direct" },
                    { label: "Concise", value: "concise" },
                  ],
                }),
                mutate: (values, context) => {
                  loadState(context).tone = values[0] ?? "friendly";
                },
              },
              {
                kind: "mentionable-select",
                id: "staff",
                label: "Support staff",
                description: "Choose any combination of users and roles.",
                load: (context) => ({
                  value: `${String(loadState(context).staff.length)} selected`,
                  defaults: loadState(context).staff,
                  minValues: 0,
                  maxValues: 10,
                }),
                mutate: (values, context) => {
                  loadState(context).staff = values.map(({ kind, id }) => ({
                    kind,
                    id,
                  }));
                },
              },
              {
                kind: "channel-select",
                id: "hub",
                label: "Support hub",
                load: (context) => ({
                  value: loadState(context).hubChannelId
                    ? `<#${loadState(context).hubChannelId}>`
                    : "Not selected",
                  ...(loadState(context).hubChannelId === undefined
                    ? {}
                    : {
                        defaultChannelIds: [loadState(context).hubChannelId!],
                      }),
                }),
                mutate: (values, context) => {
                  const state = loadState(context);
                  const selected = values[0]?.id;
                  if (selected === undefined) {
                    delete state.hubChannelId;
                  } else {
                    state.hubChannelId = selected;
                  }
                },
              },
              {
                kind: "modal",
                id: "identity",
                label: "Assistant identity",
                description: "One character deliberately fails domain validation.",
                title: "Edit assistant identity",
                inputs: [
                  {
                    id: "name",
                    label: "Display name",
                    placeholder: "Prod",
                    minLength: 1,
                    maxLength: 32,
                  },
                ],
                load: (context) => ({
                  value: loadState(context).assistantName,
                  values: { name: loadState(context).assistantName },
                  buttonLabel: "Edit",
                }),
                validate: (values) =>
                  (values.name?.trim().length ?? 0) < 2
                    ? [
                        {
                          inputId: "name",
                          message: "Use at least two visible characters.",
                        },
                      ]
                    : [],
                mutate: (values, context) => {
                  loadState(context).assistantName = values.name!.trim();
                },
              },
            ],
          },
          {
            id: "pagination",
            label: "Pagination",
            description: "A deliberately long field list exercises page controls.",
            fields: Array.from({ length: 15 }, (_, index) => ({
              kind: "display" as const,
              id: `limit-${String(index + 1)}`,
              label: `Synthetic value ${String(index + 1)}`,
              load: () => ({ value: `Value ${String(index + 1)}` }),
            })),
          },
        ],
      },
      {
        id: "diagnostics",
        label: "Diagnostics",
        description: "Prove consumer-defined category navigation.",
        authorize,
        subcategories: [
          {
            id: "runtime",
            label: "Runtime",
            fields: [
              {
                kind: "display",
                id: "boundary",
                label: "Package boundary",
                load: () => ({
                  value: "Rendered by @protocord/settings for an app-owned consumer",
                }),
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
      logger.error({ err: error }, "synthetic settings interaction failed");
    },
  });
  const action: SyntheticSettingsConsumer["action"] = {
    name: "open_settings",
    description: "Open the development settings validation surface.",
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
        description: "Open the development settings validation surface",
        registration: {
          defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
        },
        parse: () => ({}),
        present: async () => undefined,
      }),
    ],
    availability: () => ({ available: true }),
    authorization: () => undefined,
    execute: async (invocation) => {
      const interaction = invocation.rawEvent as ChatInputCommandInteraction;
      return runtime.open(interaction, settingsContext(interaction));
    },
  };

  return Object.freeze({
    action,
    handle: (interaction) =>
      runtime.handle(interaction, settingsContext(interaction)),
  });
}

function settingsContext(interaction: Interaction): SyntheticSettingsContext {
  return {
    ...(interaction.guildId === null ? {} : { guildId: interaction.guildId }),
    userId: interaction.user.id,
    canManageGuild:
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ??
      false,
  };
}
