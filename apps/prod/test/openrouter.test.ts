import { describe, expect, it, vi } from "vitest";

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
      apiKey: "deployment-secret",
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
          Authorization: "Bearer deployment-secret",
        },
      },
    );
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
});
