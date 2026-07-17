import type {
  ModelProvider,
  ProviderCatalog,
  ProviderCatalogResult,
  ProviderModel,
} from "./contracts.js";

const MAX_MODELS = 25;
const MAX_LABEL_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 100;

const validModelId = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 100 &&
  !/\s/u.test(value) &&
  !value.includes("://");

const bounded = (value: string, maximum: number): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

export const normalizeProviderModels = (
  models: readonly ProviderModel[],
): readonly ProviderModel[] => {
  const unique = new Map<string, ProviderModel>();
  for (const model of models) {
    if (!validModelId(model.id) || unique.has(model.id)) continue;
    const name = model.name.trim();
    unique.set(
      model.id,
      Object.freeze({
        id: model.id,
        name: bounded(name.length === 0 ? model.id : name, MAX_LABEL_LENGTH),
        ...(model.description === undefined ||
        model.description.trim().length === 0
          ? {}
          : {
              description: bounded(
                model.description.trim(),
                MAX_DESCRIPTION_LENGTH,
              ),
            }),
      }),
    );
  }
  return Object.freeze(
    [...unique.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_MODELS),
  );
};

export const loadProviderModels = async (
  catalog: ProviderCatalog,
  provider: ModelProvider,
): Promise<ProviderCatalogResult> => {
  try {
    return Object.freeze({
      available: true as const,
      models: normalizeProviderModels(await catalog.listModels(provider)),
    });
  } catch {
    return Object.freeze({
      available: false as const,
      models: Object.freeze([] as const),
      message:
        "Model suggestions are temporarily unavailable. Enter a model ID manually." as const,
    });
  }
};
