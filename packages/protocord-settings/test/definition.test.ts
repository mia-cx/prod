import { describe, expect, it } from "vitest";

import {
  defineSettings,
  SettingsDefinitionError,
  SETTINGS_LIMITS,
  type SettingsDefinition,
} from "../src/index.js";

const validDefinition = (): SettingsDefinition<unknown> => ({
  title: "Synthetic settings",
  categories: [
    {
      id: "setup",
      label: "Setup",
      authorize: () => true,
      subcategories: [
        {
          id: "general",
          label: "General",
          fields: [
            {
              kind: "display",
              id: "status",
              label: "Status",
              load: () => ({ value: "Ready" }),
            },
          ],
        },
      ],
    },
  ],
});

describe("consumer settings definitions", () => {
  it("accepts a definition composed entirely through the public contract", () => {
    const definition = validDefinition();

    expect(defineSettings(definition)).toBe(definition);
  });

  it("rejects duplicate and unstable consumer IDs", () => {
    const definition = validDefinition();
    const category = definition.categories[0]!;
    const duplicate = {
      ...definition,
      categories: [category, category],
    };

    expect(() => defineSettings(duplicate)).toThrowError(
      new SettingsDefinitionError("duplicate category id: setup"),
    );
    expect(() =>
      defineSettings({
        ...definition,
        categories: [{ ...category, id: "Setup page" }],
      }),
    ).toThrow(/must match/);
  });

  it("enforces Discord definition limits before rendering", () => {
    const definition = validDefinition();
    const category = definition.categories[0]!;
    const tooManyCategories = Array.from(
      { length: SETTINGS_LIMITS.categories + 1 },
      (_, index) => ({ ...category, id: `c${String(index)}` }),
    );

    expect(() =>
      defineSettings({ ...definition, categories: tooManyCategories }),
    ).toThrow(/at most 25 categories/);
    expect(() =>
      defineSettings({
        ...definition,
        categories: [
          {
            ...category,
            subcategories: [
              {
                id: "modal-page",
                label: "Modal page",
                fields: [
                  {
                    kind: "modal",
                    id: "edit",
                    label: "Edit",
                    title: "Edit",
                    inputs: [],
                    load: () => ({}),
                    mutate: () => undefined,
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(/between 1 and 5 inputs/);
  });
});
