import {
  createSettingsRenderer,
  validateSettingsDefinition,
} from "@protocord/settings";
import { describe, expect, it, vi } from "vitest";

import {
  createModelSettingsCategory,
  InvalidModelConfigurationError,
  type GuildModelConfiguration,
  type ModelConfigurationStore,
} from "../src/index.js";

type Context = Readonly<{ guildId: string; authorized: boolean }>;
const guildId = "123456789012345678";
const secret = "sk-or-v1-never-render-this-1234";
const secretHint = "sk-o•••••••••••••••••••••••1234";

const setup = () => {
  let configuration: GuildModelConfiguration = {
    guildId,
    purpose: "triage",
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4",
  };
  const store: ModelConfigurationStore = {
    get: vi.fn(async () => configuration),
    setModel: vi.fn(async (input) => {
      configuration = { ...configuration, modelId: input.modelId };
    }),
    setGuildApiKey: vi.fn(async (input) => {
      expect(input.apiKey).toBe(secret);
      configuration = { ...configuration, guildApiKeyHint: secretHint };
    }),
    clearGuildApiKey: vi.fn(async () => {
      configuration = {
        guildId: configuration.guildId,
        purpose: configuration.purpose,
        provider: configuration.provider,
        modelId: configuration.modelId,
      };
    }),
  };
  const category = createModelSettingsCategory<Context>({
    store,
    authorize: (context) => context.authorized,
    getGuildId: (context) => context.guildId,
    deploymentCredentialConfigured: true,
  });
  return { category, store };
};

const field = (
  category: ReturnType<typeof setup>["category"],
  fieldId: string,
) => {
  for (const candidate of category.fields ?? []) {
    if (candidate.id === fieldId) return candidate;
    if (candidate.kind === "action-row") {
      const item = candidate.items.find(({ id }) => id === fieldId);
      if (item !== undefined) return item;
    }
  }
  throw new Error(`Missing field ${fieldId}`);
};

describe("model settings category", () => {
  it("exports one direct model page with caller authorization", async () => {
    const { category } = setup();
    expect(() =>
      validateSettingsDefinition({ title: "Settings", categories: [category] }),
    ).not.toThrow();
    expect(await category.authorize({ guildId, authorized: false })).toBe(
      false,
    );
    expect(category.subcategories).toBeUndefined();
    expect(category.fields?.map(({ id }) => id)).toEqual([
      "provider",
      "guild-api-key",
      "model-id",
      "credential-actions",
    ]);
  });

  it("renders the provider, API key, and selected model without a page selector", async () => {
    const { category } = setup();
    const renderer = createSettingsRenderer({
      title: "Prod settings",
      categories: [category],
    });

    const view = await renderer.render(
      { categoryId: "model" },
      { guildId, authorized: true },
    );
    const payload = JSON.stringify(view.components);
    expect(payload).not.toContain("Choose a settings page");
    expect(payload).not.toContain("Catalog suggestions");
    expect(payload).toContain("Provider");
    expect(payload).toContain("**API key:**");
    expect(payload).toContain("Set API key");
    expect(payload).toContain("**Model:**");
    expect(payload).toContain("Set Model");
  });

  it("offers only OpenRouter and accepts any valid model ID", async () => {
    const { category, store } = setup();
    const context = { guildId, authorized: true };
    const provider = field(category, "provider");
    const model = field(category, "model-id");
    if (provider.kind !== "string-select" || model.kind !== "modal") {
      throw new Error("Unexpected field kinds");
    }

    await expect(provider.load(context)).resolves.toMatchObject({
      options: [{ label: "OpenRouter", value: "openrouter", default: true }],
      selectedValues: ["openrouter"],
    });
    await model.mutate({ "model-id": "google/gemini-2.5-flash" }, context);
    expect(store.setModel).toHaveBeenCalledWith({
      guildId,
      purpose: "triage",
      provider: "openrouter",
      modelId: "google/gemini-2.5-flash",
    });
    await expect(model.load(context)).resolves.toMatchObject({
      value: "`google/gemini-2.5-flash`",
      buttonLabel: "Set Model",
    });
  });

  it("sets, masks, and clears BYOK without returning the complete key", async () => {
    const { category, store } = setup();
    const context = { guildId, authorized: true };
    const key = field(category, "guild-api-key");
    const clear = field(category, "clear-guild-api-key");
    if (key.kind !== "modal" || clear.kind !== "button") {
      throw new Error("Unexpected field kinds");
    }
    expect(key.presentation).toEqual({ kind: "inline" });
    expect(key.inputs).toContainEqual(
      expect.objectContaining({ id: "api-key", sensitive: true }),
    );

    await key.mutate({ "api-key": secret }, context);
    const configuredView = await key.load(context);
    expect(JSON.stringify(configuredView)).not.toContain(secret);
    expect(configuredView).toEqual({
      value: `\`${secretHint}\``,
      buttonLabel: "Set API key",
    });
    await expect(clear.visible?.(context)).resolves.toBe(true);

    const renderer = createSettingsRenderer({
      title: "Prod settings",
      categories: [category],
    });
    const configuredPage = await renderer.render(
      { categoryId: "model" },
      context,
    );
    const payload = JSON.stringify(configuredPage.components);
    expect(payload).toContain(`\`${secretHint}\``);
    expect(payload).toContain("**API key:**");
    expect(payload).toContain("**Model:**");
    expect(payload).not.toContain("Configured");
    expect(payload).not.toContain("## API key");
    expect(payload).not.toContain("## Model");
    expect(payload).toContain("Clear API key");
    expect(payload).not.toContain("Credential actions");
    expect(payload).not.toContain(secret);

    await clear.mutate(context);
    expect(store.clearGuildApiKey).toHaveBeenCalledWith(guildId, "triage");
    await expect(key.load(context)).resolves.toEqual({
      value: "Using the deployment API key",
      buttonLabel: "Set API key",
    });
  });

  it("rejects unsupported providers, URLs, whitespace, and empty credentials", async () => {
    const { category } = setup();
    const context = { guildId, authorized: true };
    const provider = field(category, "provider");
    const model = field(category, "model-id");
    const key = field(category, "guild-api-key");
    if (
      provider.kind !== "string-select" ||
      model.kind !== "modal" ||
      key.kind !== "modal"
    ) {
      throw new Error("Unexpected field kinds");
    }
    expect(provider.mutate(["unsupported"], context)).toMatchObject({
      status: "invalid",
    });
    await expect(
      model.mutate({ "model-id": "https://example.test/model" }, context),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      key.mutate({ "api-key": " key with spaces " }, context),
    ).resolves.toMatchObject({ status: "invalid" });
  });

  it("maps store rejections to invalid results and rethrows other errors", async () => {
    const { category, store } = setup();
    const context = { guildId, authorized: true };
    const model = field(category, "model-id");
    if (model.kind !== "modal") throw new Error("Unexpected field kind");

    vi.mocked(store.setModel).mockRejectedValueOnce(
      new InvalidModelConfigurationError("modelId is invalid"),
    );
    await expect(
      model.mutate({ "model-id": "anthropic/claude-sonnet-4" }, context),
    ).resolves.toMatchObject({ status: "invalid" });

    vi.mocked(store.setModel).mockRejectedValueOnce(new Error("disk failure"));
    await expect(
      model.mutate({ "model-id": "anthropic/claude-sonnet-4" }, context),
    ).rejects.toThrow("disk failure");
  });
});
