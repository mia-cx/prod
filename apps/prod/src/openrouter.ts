import type {
  ModelProvider,
  ProviderCatalog,
  ProviderModel,
} from "@mia-cx/protocord-model-settings";

type Fetch = typeof globalThis.fetch;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type OpenRouterModelsResponse = Readonly<{
  data?: readonly Readonly<{
    id?: unknown;
    name?: unknown;
    description?: unknown;
  }>[];
}>;

export type CreateOpenRouterCatalogOptions = Readonly<{
  baseUrl: string;
  fetch?: Fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
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

const assertPositiveInteger = (label: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
};

const readBoundedJson = async (
  response: Response,
  maxResponseBytes: number,
): Promise<unknown> => {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maxResponseBytes
  ) {
    throw new OpenRouterCatalogError();
  }
  if (response.body === null) throw new OpenRouterCatalogError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      await reader.cancel();
      throw new OpenRouterCatalogError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
};

export const createOpenRouterCatalog = (
  options: CreateOpenRouterCatalogOptions,
): ProviderCatalog => {
  const fetch = options.fetch ?? globalThis.fetch;
  const endpoint = new URL("models", options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  assertPositiveInteger("timeoutMs", timeoutMs);
  assertPositiveInteger("maxResponseBytes", maxResponseBytes);
  return Object.freeze({
    listModels: async (provider: ModelProvider) => {
      if (provider !== "openrouter") throw new OpenRouterCatalogError();
      let response: Response;
      try {
        response = await fetch(endpoint, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new OpenRouterCatalogError();
      }
      if (!response.ok) throw new OpenRouterCatalogError();
      try {
        return parseModels(await readBoundedJson(response, maxResponseBytes));
      } catch (error) {
        if (error instanceof OpenRouterCatalogError) throw error;
        throw new OpenRouterCatalogError();
      }
    },
  });
};
