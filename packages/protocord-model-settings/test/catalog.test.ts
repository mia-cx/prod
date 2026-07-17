import { describe, expect, it, vi } from "vitest";

import {
  loadProviderModels,
  normalizeProviderModels,
  type ProviderCatalog,
} from "../src/index.js";

describe("provider catalog boundary", () => {
  it("normalizes, bounds, deduplicates, and sorts provider suggestions", () => {
    const models = normalizeProviderModels([
      { id: "z/model", name: "Zulu" },
      { id: "a/model", name: " Alpha " },
      { id: "a/model", name: "Duplicate" },
      { id: "https://secret.example/model", name: "URL" },
      { id: "contains whitespace", name: "Invalid" },
      {
        id: "long/model",
        name: "n".repeat(120),
        description: `  ${"d".repeat(120)}  `,
      },
    ]);

    expect(models.map(({ id }) => id)).toEqual([
      "a/model",
      "long/model",
      "z/model",
    ]);
    expect(models[1]?.name).toHaveLength(100);
    expect(models[1]?.description).toHaveLength(100);
  });

  it("returns safe catalog suggestions through the injected adapter", async () => {
    const catalog: ProviderCatalog = {
      listModels: vi.fn(async () => [
        { id: "openai/gpt-5-mini", name: "GPT-5 mini" },
      ]),
    };

    await expect(loadProviderModels(catalog, "openrouter")).resolves.toEqual({
      available: true,
      models: [{ id: "openai/gpt-5-mini", name: "GPT-5 mini" }],
    });
    expect(catalog.listModels).toHaveBeenCalledWith("openrouter");
  });

  it("turns provider failures into a manual-entry-safe result without details", async () => {
    const secret = "authorization-header-secret";
    const catalog: ProviderCatalog = {
      listModels: async () => {
        throw new Error(`catalog rejected ${secret}`);
      },
    };

    const result = await loadProviderModels(catalog, "openrouter");
    expect(result).toEqual({
      available: false,
      models: [],
      message:
        "Model suggestions are temporarily unavailable. Enter a model ID manually.",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
