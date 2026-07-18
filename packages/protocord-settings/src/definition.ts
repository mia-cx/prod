import type {
  SettingsDefinition,
  SettingsField,
  SettingsModalField,
} from "./contracts.js";

export const SETTINGS_LIMITS = Object.freeze({
  categories: 25,
  subcategoriesPerCategory: 25,
  fieldsPerSubcategory: 100,
  selectOptions: 25,
  modalInputs: 5,
  customIdLength: 100,
  containerComponents: 10,
  actionRowButtons: 5,
  textDisplayCharacters: 4_000,
  textDisplayCharactersPerMessage: 4_000,
});

const STABLE_ID = /^[a-z0-9][a-z0-9_-]{0,23}$/;

export class SettingsDefinitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SettingsDefinitionError";
  }
}

export function defineSettings<Context>(
  definition: SettingsDefinition<Context>,
): SettingsDefinition<Context> {
  validateSettingsDefinition(definition);
  return definition;
}

export function validateSettingsDefinition<Context>(
  definition: SettingsDefinition<Context>,
): void {
  assertText("settings title", definition.title, 1, 100);
  if (definition.categories.length === 0) {
    fail("settings must define at least one category");
  }
  if (definition.categories.length > SETTINGS_LIMITS.categories) {
    fail(`settings may define at most ${SETTINGS_LIMITS.categories} categories`);
  }
  if (
    definition.accentColor !== undefined &&
    (!Number.isInteger(definition.accentColor) ||
      definition.accentColor < 0 ||
      definition.accentColor > 0xffffff)
  ) {
    fail("settings accentColor must be an integer between 0x000000 and 0xFFFFFF");
  }

  assertUnique(
    definition.categories.map(({ id }) => id),
    "category",
  );
  for (const category of definition.categories) {
    assertStableId("category", category.id);
    assertText(`category ${category.id} label`, category.label, 1, 100);
    assertOptionalText(
      `category ${category.id} description`,
      category.description,
      4_000,
    );
    const hasFields = category.fields !== undefined;
    const hasSubcategories = category.subcategories !== undefined;
    if (hasFields === hasSubcategories) {
      fail(
        `category ${category.id} must define either direct fields or subcategories`,
      );
    }
    if (hasFields) {
      validateFields(category.fields!, `category ${category.id}`);
      continue;
    }
    const subcategories = category.subcategories!;
    if (subcategories.length === 0) {
      fail(`category ${category.id} must define at least one subcategory`);
    }
    if (
      subcategories.length > SETTINGS_LIMITS.subcategoriesPerCategory
    ) {
      fail(
        `category ${category.id} may define at most ${SETTINGS_LIMITS.subcategoriesPerCategory} subcategories`,
      );
    }
    assertUnique(
      subcategories.map(({ id }) => id),
      `subcategory in category ${category.id}`,
    );
    for (const subcategory of subcategories) {
      assertStableId("subcategory", subcategory.id);
      assertText(
        `subcategory ${subcategory.id} label`,
        subcategory.label,
        1,
        100,
      );
      assertOptionalText(
        `subcategory ${subcategory.id} description`,
        subcategory.description,
        4_000,
      );
      validateFields(subcategory.fields, `subcategory ${subcategory.id}`);
    }
  }
}

function validateFields<Context>(
  fields: readonly SettingsField<Context>[],
  owner: string,
): void {
  if (fields.length > SETTINGS_LIMITS.fieldsPerSubcategory) {
    fail(
      `${owner} may define at most ${SETTINGS_LIMITS.fieldsPerSubcategory} fields`,
    );
  }
  assertUnique(
    fields.map(({ id }) => id),
    `field in ${owner}`,
  );
  for (const field of fields) {
    validateField(field, owner);
  }
}

function validateField<Context>(
  field: SettingsField<Context>,
  subcategoryId: string,
): void {
  assertStableId("field", field.id);
  assertText(`field ${field.id} label`, field.label, 1, 80);
  assertOptionalText(`field ${field.id} description`, field.description, 4_000);
  if (field.kind === "modal") {
    validateModalField(field, subcategoryId);
  }
}

function validateModalField<Context>(
  field: SettingsModalField<Context>,
  subcategoryId: string,
): void {
  assertText(`modal ${field.id} title`, field.title, 1, 45);
  if (
    field.inputs.length === 0 ||
    field.inputs.length > SETTINGS_LIMITS.modalInputs
  ) {
    fail(
      `modal field ${field.id} in ${subcategoryId} must define between 1 and ${SETTINGS_LIMITS.modalInputs} inputs`,
    );
  }
  assertUnique(
    field.inputs.map(({ id }) => id),
    `input in modal field ${field.id}`,
  );
  for (const input of field.inputs) {
    assertStableId("modal input", input.id);
    assertText(`modal input ${input.id} label`, input.label, 1, 45);
    assertOptionalText(
      `modal input ${input.id} description`,
      input.description,
      100,
    );
    assertOptionalText(
      `modal input ${input.id} placeholder`,
      input.placeholder,
      100,
    );
    if (
      input.minLength !== undefined &&
      (!Number.isInteger(input.minLength) ||
        input.minLength < 0 ||
        input.minLength > 4_000)
    ) {
      fail(`modal input ${input.id} minLength must be between 0 and 4000`);
    }
    if (
      input.maxLength !== undefined &&
      (!Number.isInteger(input.maxLength) ||
        input.maxLength < 1 ||
        input.maxLength > 4_000)
    ) {
      fail(`modal input ${input.id} maxLength must be between 1 and 4000`);
    }
    if (
      input.minLength !== undefined &&
      input.maxLength !== undefined &&
      input.minLength > input.maxLength
    ) {
      fail(`modal input ${input.id} minLength must not exceed maxLength`);
    }
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      fail(`duplicate ${label} id: ${value}`);
    }
    seen.add(value);
  }
}

function assertStableId(label: string, value: string): void {
  if (!STABLE_ID.test(value)) {
    fail(
      `${label} id ${JSON.stringify(value)} must match ${String(STABLE_ID)}`,
    );
  }
}

function assertText(
  label: string,
  value: string,
  minimum: number,
  maximum: number,
): void {
  if (value.length < minimum || value.length > maximum) {
    fail(`${label} must contain between ${minimum} and ${maximum} characters`);
  }
}

function assertOptionalText(
  label: string,
  value: string | undefined,
  maximum: number,
): void {
  if (value !== undefined) {
    assertText(label, value, 1, maximum);
  }
}

function fail(message: string): never {
  throw new SettingsDefinitionError(message);
}
