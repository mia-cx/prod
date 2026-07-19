import type {
  SettingsAuthorization,
  SettingsCategory,
  SettingsModalValues,
  SettingsMutationResult,
  SettingsValidationIssue,
} from "@protocord/settings";

import { loadProviderModels } from "./catalog.js";
import {
  InvalidModelConfigurationError,
  type ModelConfigurationStore,
  type ProviderCatalog,
} from "./contracts.js";

const purpose = "triage" as const;
const provider = "openrouter" as const;
const KEEP_CURRENT = "keep-current";

export type CreateModelSettingsCategoryOptions<Context> = Readonly<{
  store: ModelConfigurationStore;
  catalog: ProviderCatalog;
  authorize: SettingsAuthorization<Context>;
  getGuildId(context: Context): string;
  deploymentCredentialConfigured: boolean;
}>;

const issue = (message: string, inputId?: string): SettingsValidationIssue => ({
  message,
  ...(inputId === undefined ? {} : { inputId }),
});

const invalid = (
  issues: readonly SettingsValidationIssue[],
): SettingsMutationResult => ({ status: "invalid", issues });

const modalText = (values: SettingsModalValues, inputId: string): string => {
  const value = values[inputId];
  return typeof value === "string" ? value : "";
};

const modelIdIssue = (value: string): SettingsValidationIssue | undefined => {
  if (
    value.length === 0 ||
    value.length > 200 ||
    /\s/u.test(value) ||
    value.includes("://")
  ) {
    return issue(
      "Enter a model ID such as anthropic/claude-sonnet-4, not a URL.",
      "model-id",
    );
  }
  return undefined;
};

const apiKeyIssue = (value: string): SettingsValidationIssue | undefined => {
  if (value.length === 0 || value.length > 4_000 || /\s/u.test(value)) {
    return issue(
      "Enter the API key without spaces or surrounding whitespace.",
      "api-key",
    );
  }
  return undefined;
};

export function createModelSettingsCategory<Context>(
  options: CreateModelSettingsCategoryOptions<Context>,
): SettingsCategory<Context> {
  const configuration = (context: Context) =>
    options.store.get(options.getGuildId(context), purpose);

  const category: SettingsCategory<Context> = {
    id: "model",
    label: "Model",
    description: "Configure OpenRouter models and server credentials.",
    authorize: options.authorize,
    subcategories: [
      {
        id: "triage",
        label: "Triage model",
        description:
          "Choose the OpenRouter model used for ticket triage suggestions.",
        fields: [
          {
            kind: "display",
            id: "provider",
            label: "Provider",
            load: () => ({ value: "OpenRouter (`openrouter`)" }),
          },
          {
            kind: "string-select",
            id: "catalog-model",
            label: "Catalog suggestions",
            description:
              "Fetch current model suggestions. Manual model entry remains available during catalog outages.",
            load: async (context) => {
              const current = await configuration(context);
              const catalog = await loadProviderModels(
                options.catalog,
                provider,
              );
              if (!catalog.available || catalog.models.length === 0) {
                return {
                  value: catalog.available
                    ? "No catalog suggestions are currently available. Enter a model ID manually."
                    : catalog.message,
                  options: [
                    {
                      label: "Keep current model",
                      value: KEEP_CURRENT,
                    },
                  ],
                  selectedValues: [KEEP_CURRENT],
                  minValues: 1,
                  maxValues: 1,
                };
              }
              const includesCurrent = catalog.models.some(
                (model) => model.id === current.modelId,
              );
              const models = includesCurrent
                ? catalog.models
                : [
                    {
                      id: KEEP_CURRENT,
                      name: "Current model (manual)",
                    },
                    ...catalog.models.slice(0, 24),
                  ];
              return {
                value: `Current: \`${current.modelId}\``,
                options: models.map((model) => ({
                  label: model.name,
                  value: model.id,
                  ...(model.description === undefined
                    ? {}
                    : { description: model.description }),
                })),
                selectedValues: [
                  includesCurrent ? current.modelId : KEEP_CURRENT,
                ],
                placeholder: "Choose an OpenRouter model",
                minValues: 1,
                maxValues: 1,
              };
            },
            validate: (values) => {
              const selected = values[0];
              if (selected === KEEP_CURRENT) return [];
              const validationIssue =
                selected === undefined
                  ? modelIdIssue("")
                  : modelIdIssue(selected);
              return validationIssue === undefined ? [] : [validationIssue];
            },
            mutate: async (values, context) => {
              const modelId = values[0];
              if (modelId === KEEP_CURRENT) return;
              const validationIssue =
                modelId === undefined
                  ? modelIdIssue("")
                  : modelIdIssue(modelId);
              if (validationIssue !== undefined)
                return invalid([validationIssue]);
              await options.store.setModel({
                guildId: options.getGuildId(context),
                purpose,
                provider,
                modelId: modelId!,
              });
            },
          },
          {
            kind: "modal",
            id: "manual-model",
            label: "Manual model ID",
            description:
              "Set any valid OpenRouter model identifier without relying on the catalog.",
            title: "Set triage model",
            inputs: [
              {
                id: "model-id",
                label: "OpenRouter model ID",
                placeholder: "anthropic/claude-sonnet-4",
                required: true,
                minLength: 1,
                maxLength: 200,
              },
            ],
            load: async (context) => {
              const current = await configuration(context);
              return {
                value: `Current: \`${current.modelId}\``,
                values: { "model-id": current.modelId },
                buttonLabel: "Edit model ID",
              };
            },
            validate: (values) => {
              const validationIssue = modelIdIssue(
                modalText(values, "model-id"),
              );
              return validationIssue === undefined ? [] : [validationIssue];
            },
            mutate: async (values, context) => {
              const modelId = modalText(values, "model-id");
              const validationIssue = modelIdIssue(modelId);
              if (validationIssue !== undefined)
                return invalid([validationIssue]);
              try {
                await options.store.setModel({
                  guildId: options.getGuildId(context),
                  purpose,
                  provider,
                  modelId,
                });
              } catch (error) {
                if (error instanceof InvalidModelConfigurationError) {
                  return invalid([modelIdIssue("")!]);
                }
                throw error;
              }
            },
          },
        ],
      },
      {
        id: "credentials",
        label: "Credentials",
        description:
          "Use an encrypted server API key or fall back to deployment credentials.",
        fields: [
          {
            kind: "display",
            id: "credential-status",
            label: "Credential source",
            load: async (context) => {
              const current = await configuration(context);
              if (current.guildApiKeyHint !== undefined) {
                return {
                  value: `Server BYOK configured (${current.guildApiKeyHint}).`,
                };
              }
              return {
                value: options.deploymentCredentialConfigured
                  ? "Using deployment-default credentials."
                  : "No credential configured; AI triage is unavailable.",
              };
            },
          },
          {
            kind: "modal",
            id: "guild-api-key",
            label: "Server API key",
            description:
              "Replace the encrypted server credential. Existing keys are never displayed.",
            title: "Set server OpenRouter key",
            inputs: [
              {
                id: "api-key",
                label: "OpenRouter API key",
                placeholder: "Paste a new key",
                required: true,
                minLength: 1,
                maxLength: 4_000,
              },
            ],
            load: async (context) => {
              const current = await configuration(context);
              return {
                value:
                  current.guildApiKeyHint === undefined
                    ? "No server key stored."
                    : `Stored key: ${current.guildApiKeyHint}`,
                buttonLabel:
                  current.guildApiKeyHint === undefined
                    ? "Set server key"
                    : "Replace server key",
              };
            },
            validate: (values) => {
              const validationIssue = apiKeyIssue(modalText(values, "api-key"));
              return validationIssue === undefined ? [] : [validationIssue];
            },
            mutate: async (values, context) => {
              const apiKey = modalText(values, "api-key");
              const validationIssue = apiKeyIssue(apiKey);
              if (validationIssue !== undefined)
                return invalid([validationIssue]);
              await options.store.setGuildApiKey({
                guildId: options.getGuildId(context),
                purpose,
                apiKey,
              });
            },
          },
          {
            kind: "button",
            id: "clear-guild-api-key",
            label: "Clear server API key",
            description:
              "Remove the encrypted server credential and use deployment fallback when available.",
            load: async (context) => {
              const current = await configuration(context);
              return {
                value:
                  current.guildApiKeyHint === undefined
                    ? "No server key stored."
                    : `Stored key: ${current.guildApiKeyHint}`,
                buttonLabel: "Clear server key",
                disabled: current.guildApiKeyHint === undefined,
              };
            },
            mutate: async (context) => {
              await options.store.clearGuildApiKey(
                options.getGuildId(context),
                purpose,
              );
            },
          },
        ],
      },
    ],
  };
  return Object.freeze(category);
}
