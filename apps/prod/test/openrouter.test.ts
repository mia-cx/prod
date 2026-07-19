import { describe, expect, it, vi } from "vitest";
import {
  createModelSettingsCategory,
  type ModelConfigurationStore,
} from "@mia-cx/protocord-model-settings";
import { createSettingsRenderer } from "@protocord/settings";

import {
  createOpenRouterCatalog,
  OpenRouterCatalogError,
} from "../src/openrouter.js";

describe("OpenRouter catalog adapter", () => {
  it("fetches and maps models through the deployment-controlled endpoint", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        data: [
          {
            id: "openai/gpt-5-mini",
            name: "GPT-5 mini",
            description: "Fast model",
          },
          { id: "unnamed/model" },
          { name: "missing identifier" },
        ],
      }),
    );
    const catalog = createOpenRouterCatalog({
      baseUrl: "https://router.example.test/api/v1/",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(catalog.listModels("openrouter")).resolves.toEqual([
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 mini",
        description: "Fast model",
      },
      { id: "unnamed/model", name: "unnamed/model" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://router.example.test/api/v1/models"),
      {
        headers: {
          Accept: "application/json",
        },
        signal: expect.any(AbortSignal),
      },
    );
    expect(JSON.stringify(fetch.mock.calls)).not.toContain("deployment-secret");
  });

  it("returns only a generic error for transport, status, and payload failures", async () => {
    const secret = "response-body-secret";
    for (const fetch of [
      vi.fn(async () => {
        throw new Error(secret);
      }),
      vi.fn(async () => new Response(secret, { status: 401 })),
      vi.fn(async () => Response.json({ error: secret })),
    ]) {
      const catalog = createOpenRouterCatalog({
        baseUrl: "https://router.example.test/api/v1/",
        fetch: fetch as typeof globalThis.fetch,
      });
      try {
        await catalog.listModels("openrouter");
        throw new Error("Expected catalog failure");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenRouterCatalogError);
        expect(String(error)).not.toContain(secret);
      }
    }
  });

  it("aborts stalled requests within the configured deadline", async () => {
    const fetch = vi.fn(
      async (
        _input: Parameters<typeof globalThis.fetch>[0],
        init?: RequestInit,
      ) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("timed out", "AbortError")),
            { once: true },
          );
        }),
    );
    const catalog = createOpenRouterCatalog({
      baseUrl: "https://openrouter.ai/api/v1/",
      fetch: fetch as typeof globalThis.fetch,
      timeoutMs: 10,
    });

    await expect(catalog.listModels("openrouter")).rejects.toThrow(
      OpenRouterCatalogError,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("renders manual model entry after a catalog request times out", async () => {
    const fetch = vi.fn(
      async (
        _input: Parameters<typeof globalThis.fetch>[0],
        init?: RequestInit,
      ) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("timed out", "AbortError")),
            { once: true },
          );
        }),
    );
    const store: ModelConfigurationStore = {
      get: async (guildId, purpose) => ({
        guildId,
        purpose,
        provider: "openrouter",
        modelId: "google/gemma-4-31b-it",
      }),
      setModel: async () => undefined,
      setGuildApiKey: async () => undefined,
      clearGuildApiKey: async () => undefined,
    };
    const category = createModelSettingsCategory({
      store,
      catalog: createOpenRouterCatalog({
        baseUrl: "https://openrouter.ai/api/v1/",
        fetch: fetch as typeof globalThis.fetch,
        timeoutMs: 10,
      }),
      authorize: () => true,
      getGuildId: (context: { guildId: string }) => context.guildId,
      deploymentCredentialConfigured: false,
    });
    const renderer = createSettingsRenderer({
      title: "Prod settings",
      categories: [category],
    });

    const view = await renderer.render(
      { categoryId: "model", subcategoryId: "triage" },
      { guildId: "123456789012345678" },
    );
    const payload = JSON.stringify(view.components);
    expect(payload).toContain(
      "Manual model entry remains available during catalog outages.",
    );
    expect(payload).toContain("Manual model ID");
  });

  it("rejects oversized catalog responses before parsing them", async () => {
    const secret = "oversized-response-secret";
    const catalog = createOpenRouterCatalog({
      baseUrl: "https://openrouter.ai/api/v1/",
      fetch: (async () =>
        new Response(
          JSON.stringify({ data: [{ id: secret.repeat(20) }] }),
        )) as typeof globalThis.fetch,
      maxResponseBytes: 64,
    });

    try {
      await catalog.listModels("openrouter");
      throw new Error("Expected catalog failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenRouterCatalogError);
      expect(String(error)).not.toContain(secret);
    }
  });
});
