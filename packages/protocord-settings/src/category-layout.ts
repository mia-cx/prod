import type {
  SettingsCategory,
  SettingsField,
  SettingsSubcategory,
} from "./contracts.js";

export const isDirectSettingsCategory = <Context>(
  category: SettingsCategory<Context>,
): category is SettingsCategory<Context> & {
  fields: readonly SettingsField<Context>[];
} => category.fields !== undefined;

export const categoryPages = <Context>(
  category: SettingsCategory<Context>,
): readonly SettingsSubcategory<Context>[] =>
  isDirectSettingsCategory(category)
    ? [
        {
          id: category.id,
          label: category.label,
          ...(category.description === undefined
            ? {}
            : { description: category.description }),
          fields: category.fields,
        },
      ]
    : (category.subcategories ?? []);
