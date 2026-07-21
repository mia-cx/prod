import type {
  SettingsAuthorization,
  SettingsCategory,
  SettingsModalValues,
  SettingsMutationResult,
  SettingsValidationIssue,
} from "@protocord/settings";

import {
  InvalidModelConfigurationError,
  type ModelConfigurationStore,
} from "./contracts.js";

const purpose = "triage" as const;
const provider = "openrouter" as const;

export type CreateModelSettingsCategoryOptions<Context> = Readonly<{
  store: ModelConfigurationStore;
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
    description: "Configure the provider, API key, and model used for triage.",
    authorize: options.authorize,
    fields: [
      {
        kind: "string-select",
        id: "provider",
        label: "Provider",
        description: "Choose the provider used for model requests.",
        load: async (context) => {
          const current = await configuration(context);
          return {
            options: [
              {
                label: "OpenRouter",
                value: provider,
                default: current.provider === provider,
              },
            ],
            selectedValues: [current.provider],
            placeholder: "Choose a provider",
            minValues: 1,
            maxValues: 1,
          };
        },
        validate: (values) =>
          values.length === 1 && values[0] === provider
            ? []
            : [issue("Choose OpenRouter as the provider.")],
        mutate: (values) =>
          values.length === 1 && values[0] === provider
            ? undefined
            : invalid([issue("Choose OpenRouter as the provider.")]),
      },
      {
        kind: "modal",
        id: "guild-api-key",
        label: "API key",
        description:
          "Set the encrypted server credential. Existing keys are never displayed.",
        title: "Set OpenRouter API key",
        presentation: { kind: "inline" },
        inputs: [
          {
            id: "api-key",
            label: "OpenRouter API key",
            placeholder: "Paste a new key",
            required: true,
            minLength: 1,
            maxLength: 4_000,
            sensitive: true,
          },
        ],
        load: async (context) => {
          const current = await configuration(context);
          if (current.guildApiKeyHint !== undefined) {
            return {
              value: `\`${current.guildApiKeyHint}\``,
              buttonLabel: "Set API key",
            };
          }
          return {
            value: options.deploymentCredentialConfigured
              ? "Using the deployment API key"
              : "No API key configured",
            buttonLabel: "Set API key",
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
        kind: "modal",
        id: "model-id",
        label: "Model",
        description: "Set the OpenRouter model ID used for ticket triage.",
        title: "Set model ID",
        presentation: { kind: "inline" },
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
            value: `\`${current.modelId}\``,
            values: { "model-id": current.modelId },
            buttonLabel: "Set Model",
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
      {
        kind: "action-row",
        id: "credential-actions",
        label: "Credential actions",
        items: [
          {
            kind: "button",
            id: "clear-guild-api-key",
            label: "Clear API key",
            visible: async (context) =>
              (await configuration(context)).guildApiKeyHint !== undefined,
            load: () => ({ buttonLabel: "Clear API key" }),
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
