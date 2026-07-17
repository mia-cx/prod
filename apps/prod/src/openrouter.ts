import type {
  ModelProvider,
  ProviderCatalog,
  ProviderModel,
} from "@mia-cx/protocord-model-settings";

type Fetch = typeof globalThis.fetch;

type OpenRouterModelsResponse = Readonly<{
  data?: readonly Readonly<{
    id?: unknown;
    name?: unknown;
    description?: unknown;
  }>[];
}>;

export type CreateOpenRouterCatalogOptions = Readonly<{
  baseUrl: string;
  apiKey?: string;
  fetch?: Fetch;
}>;

export class OpenRouterCatalogError extends Error {
  override readonly name = "OpenRouterCatalogError";

  public constructor() {
    super("OpenRouter model catalog is unavailable");
  }
}

const parseModels = (value: unknown): readonly ProviderModel[] => {
  if (value === null || typeof value !== "object") {
    throw new OpenRouterCatalogError();
  }
  const data = (value as OpenRouterModelsResponse).data;
  if (!Array.isArray(data)) throw new OpenRouterCatalogError();
  return data.flatMap((model) => {
    if (typeof model.id !== "string") return [];
    return [
      {
        id: model.id,
        name: typeof model.name === "string" ? model.name : model.id,
        ...(typeof model.description === "string"
          ? { description: model.description }
          : {}),
      },
    ];
  });
};

export const createOpenRouterCatalog = (
  options: CreateOpenRouterCatalogOptions,
): ProviderCatalog => {
  const fetch = options.fetch ?? globalThis.fetch;
  const endpoint = new URL("models", options.baseUrl);
  return Object.freeze({
    listModels: async (provider: ModelProvider) => {
      if (provider !== "openrouter") throw new OpenRouterCatalogError();
      let response: Response;
      try {
        response = await fetch(endpoint, {
          headers:
            options.apiKey === undefined
              ? { Accept: "application/json" }
              : {
                  Accept: "application/json",
                  Authorization: `Bearer ${options.apiKey}`,
                },
        });
      } catch {
        throw new OpenRouterCatalogError();
      }
      if (!response.ok) throw new OpenRouterCatalogError();
      try {
        return parseModels(await response.json());
      } catch (error) {
        if (error instanceof OpenRouterCatalogError) throw error;
        throw new OpenRouterCatalogError();
      }
    },
  });
};
