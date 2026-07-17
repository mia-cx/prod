import { validateSettingsDefinition } from "@protocord/settings";
import { describe, expect, it, vi } from "vitest";

import {
  createModelSettingsCategory,
  type GuildModelConfiguration,
  type ModelConfigurationStore,
  type ProviderCatalog,
} from "../src/index.js";

type Context = Readonly<{ guildId: string; authorized: boolean }>;
const guildId = "123456789012345678";
const secret = "sk-or-v1-never-render-this-1234";

const setup = (
  catalog: ProviderCatalog = {
    listModels: async () => [
      { id: "openai/gpt-5-mini", name: "GPT-5 mini" },
    ],
  },
) => {
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
      configuration = { ...configuration, guildApiKeyHint: "••••1234" };
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
    catalog,
    authorize: (context) => context.authorized,
    getGuildId: (context) => context.guildId,
    deploymentCredentialConfigured: true,
  });
  return { category, store };
};

const field = (
  category: ReturnType<typeof setup>["category"],
  subcategoryId: string,
  fieldId: string,
) => {
  const subcategory = category.subcategories.find(
    ({ id }) => id === subcategoryId,
  );
  const result = subcategory?.fields.find(({ id }) => id === fieldId);
  if (result === undefined) throw new Error(`Missing field ${fieldId}`);
  return result;
};

describe("model settings category", () => {
  it("exports a complete settings-consumer category with caller authorization", async () => {
    const { category } = setup();
    expect(() =>
      validateSettingsDefinition({ title: "Settings", categories: [category] }),
    ).not.toThrow();
    expect(await category.authorize({ guildId, authorized: false })).toBe(
      false,
    );
    expect(category.subcategories.map(({ id }) => id)).toEqual([
      "triage",
      "credentials",
    ]);
  });

  it("selects catalog suggestions and permits independent manual model entry", async () => {
    const { category, store } = setup();
    const context = { guildId, authorized: true };
    const catalog = field(category, "triage", "catalog-model");
    const manual = field(category, "triage", "manual-model");
    if (catalog.kind !== "string-select" || manual.kind !== "modal") {
      throw new Error("Unexpected field kinds");
    }

    await catalog.mutate(["openai/gpt-5-mini"], context);
    await manual.mutate({ "model-id": "google/gemini-2.5-flash" }, context);
    expect(store.setModel).toHaveBeenNthCalledWith(1, {
      guildId,
      purpose: "triage",
      provider: "openrouter",
      modelId: "openai/gpt-5-mini",
    });
    expect(store.setModel).toHaveBeenNthCalledWith(2, {
      guildId,
      purpose: "triage",
      provider: "openrouter",
      modelId: "google/gemini-2.5-flash",
    });
    await expect(manual.load(context)).resolves.toMatchObject({
      value: "Current: `google/gemini-2.5-flash`",
    });
  });

  it("keeps manual entry usable and renders no adapter details during catalog failure", async () => {
    const adapterSecret = "adapter-authorization-header";
    const { category } = setup({
      listModels: async () => {
        throw new Error(adapterSecret);
      },
    });
    const catalog = field(category, "triage", "catalog-model");
    const manual = field(category, "triage", "manual-model");
    if (catalog.kind !== "string-select" || manual.kind !== "modal") {
      throw new Error("Unexpected field kinds");
    }

    const view = await catalog.load({ guildId, authorized: true });
    expect(view.value).toContain("Enter a model ID manually");
    expect(view.options).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain(adapterSecret);
    await expect(
      manual.mutate(
        { "model-id": "manual/model" },
        { guildId, authorized: true },
      ),
    ).resolves.toBeUndefined();
  });

  it("sets, masks, and clears BYOK without returning the complete key", async () => {
    const { category, store } = setup();
    const context = { guildId, authorized: true };
    const key = field(category, "credentials", "guild-api-key");
    const status = field(category, "credentials", "credential-status");
    const clear = field(category, "credentials", "clear-guild-api-key");
    if (key.kind !== "modal" || status.kind !== "display" || clear.kind !== "button") {
      throw new Error("Unexpected field kinds");
    }

    await key.mutate({ "api-key": secret }, context);
    const configuredViews = await Promise.all([
      key.load(context),
      status.load(context),
      clear.load(context),
    ]);
    expect(JSON.stringify(configuredViews)).not.toContain(secret);
    expect(JSON.stringify(configuredViews)).toContain("••••1234");

    await clear.mutate(context);
    expect(store.clearGuildApiKey).toHaveBeenCalledWith(guildId, "triage");
    await expect(status.load(context)).resolves.toEqual({
      value: "Using deployment-default credentials.",
    });
  });

  it("rejects URLs, whitespace, and empty credentials with actionable validation", async () => {
    const { category } = setup();
    const context = { guildId, authorized: true };
    const manual = field(category, "triage", "manual-model");
    const key = field(category, "credentials", "guild-api-key");
    if (manual.kind !== "modal" || key.kind !== "modal") {
      throw new Error("Unexpected field kinds");
    }
    await expect(
      manual.mutate({ "model-id": "https://example.test/model" }, context),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      key.mutate({ "api-key": " key with spaces " }, context),
    ).resolves.toMatchObject({ status: "invalid" });
  });
});
