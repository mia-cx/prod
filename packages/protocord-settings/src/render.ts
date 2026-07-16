import {
  ButtonStyle,
  ComponentType,
  SelectMenuDefaultValueType,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIChannelSelectComponent,
  type APIComponentInContainer,
  type APIComponentInMessageActionRow,
  type APIContainerComponent,
  type APIMentionableSelectComponent,
  type APIMessageTopLevelComponent,
  type APISectionComponent,
  type APIStringSelectComponent,
  type APITextDisplayComponent,
} from "discord.js";

import type {
  SettingsAuthorizationDecision,
  SettingsCategory,
  SettingsChannelSelectField,
  SettingsDefinition,
  SettingsField,
  SettingsMentionableSelectField,
  SettingsModalField,
  SettingsStringSelectField,
  SettingsSubcategory,
} from "./contracts.js";
import { SETTINGS_LIMITS, validateSettingsDefinition } from "./definition.js";
import { encodeSettingsCustomId } from "./routes.js";

export type SettingsLocation = Readonly<{
  categoryId: string;
  subcategoryId: string;
  page: number;
  pageCount: number;
}>;

export type SettingsViewNotice = Readonly<{
  kind: "success" | "error";
  message: string;
}>;

export type SettingsViewRequest = Readonly<{
  categoryId?: string;
  subcategoryId?: string;
  page?: number;
  notice?: SettingsViewNotice;
}>;

export type RenderedSettingsView = Readonly<{
  components: readonly APIMessageTopLevelComponent[];
  location: SettingsLocation;
}>;

export class SettingsViewError extends Error {
  public constructor(
    public readonly reason: "stale" | "unauthorized" | "invalid-view",
    message: string,
  ) {
    super(message);
    this.name = "SettingsViewError";
  }
}

export type SettingsRenderer<Context> = Readonly<{
  render(
    request: SettingsViewRequest,
    context: Context,
  ): Promise<RenderedSettingsView>;
}>;

export function createSettingsRenderer<Context>(
  definition: SettingsDefinition<Context>,
): SettingsRenderer<Context> {
  validateSettingsDefinition(definition);
  return Object.freeze({
    render: (request: SettingsViewRequest, context: Context) =>
      renderSettingsView(definition, request, context),
  });
}

async function renderSettingsView<Context>(
  definition: SettingsDefinition<Context>,
  request: SettingsViewRequest,
  context: Context,
): Promise<RenderedSettingsView> {
  const authorizedCategories = await findAuthorizedCategories(
    definition.categories,
    context,
  );
  if (authorizedCategories.length === 0) {
    throw new SettingsViewError(
      "unauthorized",
      "You are not authorized to view settings.",
    );
  }

  const requestedCategory =
    request.categoryId === undefined
      ? authorizedCategories[0]
      : definition.categories.find(({ id }) => id === request.categoryId);
  if (requestedCategory === undefined) {
    throw stale("category", request.categoryId ?? "");
  }
  const category = authorizedCategories.find(
    ({ id }) => id === requestedCategory.id,
  );
  if (category === undefined) {
    throw new SettingsViewError(
      "unauthorized",
      "You are not authorized to view this settings category.",
    );
  }

  const subcategory = selectSubcategory(category, request.subcategoryId);
  const fieldPages = paginateFields(
    subcategory.fields,
    fixedComponentCount(
      authorizedCategories.length,
      category.subcategories.length,
      request.notice,
    ),
  );
  const requestedPage = request.page ?? 0;
  const fields = fieldPages[requestedPage];
  if (fields === undefined) {
    throw stale("page", String(requestedPage));
  }

  const location: SettingsLocation = {
    categoryId: category.id,
    subcategoryId: subcategory.id,
    page: requestedPage,
    pageCount: fieldPages.length,
  };
  const children: APIComponentInContainer[] = [
    textDisplay(renderHeading(definition.title, category, subcategory)),
  ];
  if (authorizedCategories.length > 1) {
    children.push(categoryNavigation(authorizedCategories, location));
  }
  if (category.subcategories.length > 1) {
    children.push(subcategoryNavigation(category, location));
  }
  if (request.notice !== undefined) {
    const marker = request.notice.kind === "success" ? "✅" : "⚠️";
    children.push(textDisplay(`${marker} ${request.notice.message}`));
  }
  for (const field of fields) {
    children.push(...(await renderField(field, location, context)));
  }
  if (fieldPages.length > 1) {
    children.push(pageNavigation(location));
  }
  if (children.length > SETTINGS_LIMITS.containerComponents) {
    throw new SettingsViewError(
      "invalid-view",
      `settings view exceeds ${SETTINGS_LIMITS.containerComponents} container components`,
    );
  }

  const container: APIContainerComponent = {
    type: ComponentType.Container,
    ...(definition.accentColor === undefined
      ? {}
      : { accent_color: definition.accentColor }),
    components: children,
  };
  return { components: [container], location };
}

async function findAuthorizedCategories<Context>(
  categories: readonly SettingsCategory<Context>[],
  context: Context,
): Promise<readonly SettingsCategory<Context>[]> {
  const decisions = await Promise.all(
    categories.map(async (category) => ({
      category,
      decision: normalizeAuthorization(await category.authorize(context)),
    })),
  );
  return decisions
    .filter(({ decision }) => decision.authorized)
    .map(({ category }) => category);
}

function normalizeAuthorization(
  decision: boolean | SettingsAuthorizationDecision,
): SettingsAuthorizationDecision {
  return typeof decision === "boolean" ? { authorized: decision } : decision;
}

function selectSubcategory<Context>(
  category: SettingsCategory<Context>,
  requestedId: string | undefined,
): SettingsSubcategory<Context> {
  if (requestedId === undefined) {
    return category.subcategories[0]!;
  }
  const subcategory = category.subcategories.find(({ id }) => id === requestedId);
  if (subcategory === undefined) {
    throw stale("subcategory", requestedId);
  }
  return subcategory;
}

function fixedComponentCount(
  categoryCount: number,
  subcategoryCount: number,
  notice: SettingsViewNotice | undefined,
): number {
  return (
    1 +
    (categoryCount > 1 ? 1 : 0) +
    (subcategoryCount > 1 ? 1 : 0) +
    (notice === undefined ? 0 : 1)
  );
}

function paginateFields<Context>(
  fields: readonly SettingsField<Context>[],
  fixedComponents: number,
): readonly (readonly SettingsField<Context>[])[] {
  const unpaginatedCost = fields.reduce(
    (cost, field) => cost + fieldComponentCost(field),
    0,
  );
  if (
    fixedComponents + unpaginatedCost <=
    SETTINGS_LIMITS.containerComponents
  ) {
    return [fields];
  }

  const pageCapacity =
    SETTINGS_LIMITS.containerComponents - fixedComponents - 1;
  if (pageCapacity < 1) {
    throw new SettingsViewError(
      "invalid-view",
      "settings navigation leaves no room for fields",
    );
  }
  const pages: SettingsField<Context>[][] = [];
  let currentPage: SettingsField<Context>[] = [];
  let currentCost = 0;
  for (const field of fields) {
    const cost = fieldComponentCost(field);
    if (cost > pageCapacity) {
      throw new SettingsViewError(
        "invalid-view",
        `field ${field.id} cannot fit within the settings component limit`,
      );
    }
    if (currentCost + cost > pageCapacity) {
      pages.push(currentPage);
      currentPage = [];
      currentCost = 0;
    }
    currentPage.push(field);
    currentCost += cost;
  }
  if (currentPage.length > 0 || pages.length === 0) {
    pages.push(currentPage);
  }
  return pages;
}

function fieldComponentCost<Context>(field: SettingsField<Context>): number {
  return ["string-select", "mentionable-select", "channel-select"].includes(
    field.kind,
  )
    ? 2
    : 1;
}

async function renderField<Context>(
  field: SettingsField<Context>,
  location: SettingsLocation,
  context: Context,
): Promise<readonly APIComponentInContainer[]> {
  switch (field.kind) {
    case "display": {
      const view = await field.load(context);
      return [textDisplay(fieldText(field, view.value))];
    }
    case "button": {
      const view = await field.load(context);
      return [
        buttonSection(
          fieldText(field, view.value),
          view.buttonLabel ?? field.label,
          encodeFieldRoute("button", location, field.id),
          field.style ?? ButtonStyle.Secondary,
          view.disabled,
        ),
      ];
    }
    case "modal":
      return renderModalField(field, location, await field.load(context));
    case "string-select":
      return renderStringSelect(field, location, await field.load(context));
    case "mentionable-select":
      return renderMentionableSelect(field, location, await field.load(context));
    case "channel-select":
      return renderChannelSelect(field, location, await field.load(context));
  }
}

function renderModalField<Context>(
  field: SettingsModalField<Context>,
  location: SettingsLocation,
  view: Awaited<ReturnType<SettingsModalField<Context>["load"]>>,
): readonly APIComponentInContainer[] {
  return [
    buttonSection(
      fieldText(field, view.value),
      view.buttonLabel ?? field.label,
      encodeFieldRoute("modal", location, field.id),
      ButtonStyle.Secondary,
      view.disabled,
    ),
  ];
}

function renderStringSelect<Context>(
  field: SettingsStringSelectField<Context>,
  location: SettingsLocation,
  view: Awaited<ReturnType<SettingsStringSelectField<Context>["load"]>>,
): readonly APIComponentInContainer[] {
  validateSelectBounds(field.id, view.options.length, view.minValues, view.maxValues);
  if (view.options.length === 0) {
    throw invalidField(field.id, "must provide at least one option");
  }
  const selectedValues = new Set(view.selectedValues ?? []);
  const component: APIStringSelectComponent = {
    type: ComponentType.StringSelect,
    custom_id: encodeFieldRoute("string-select", location, field.id),
    options: view.options.map((option) => ({
      label: option.label,
      value: option.value,
      ...(option.description === undefined
        ? {}
        : { description: option.description }),
      ...(option.default === true || selectedValues.has(option.value)
        ? { default: true }
        : {}),
    })),
    ...(view.placeholder === undefined
      ? {}
      : { placeholder: view.placeholder }),
    ...(view.minValues === undefined ? {} : { min_values: view.minValues }),
    ...(view.maxValues === undefined ? {} : { max_values: view.maxValues }),
    ...(view.disabled === undefined ? {} : { disabled: view.disabled }),
  };
  return [
    textDisplay(fieldText(field, view.value)),
    actionRow(component),
  ];
}

function renderMentionableSelect<Context>(
  field: SettingsMentionableSelectField<Context>,
  location: SettingsLocation,
  view: Awaited<ReturnType<SettingsMentionableSelectField<Context>["load"]>>,
): readonly APIComponentInContainer[] {
  validateSelectBounds(field.id, undefined, view.minValues, view.maxValues);
  const component: APIMentionableSelectComponent = {
    type: ComponentType.MentionableSelect,
    custom_id: encodeFieldRoute("mentionable-select", location, field.id),
    ...(view.defaults === undefined
      ? {}
      : {
          default_values: view.defaults.map((value) => ({
            id: value.id,
            type:
              value.kind === "user"
                ? SelectMenuDefaultValueType.User
                : SelectMenuDefaultValueType.Role,
          })),
        }),
    ...(view.placeholder === undefined
      ? {}
      : { placeholder: view.placeholder }),
    ...(view.minValues === undefined ? {} : { min_values: view.minValues }),
    ...(view.maxValues === undefined ? {} : { max_values: view.maxValues }),
    ...(view.disabled === undefined ? {} : { disabled: view.disabled }),
  };
  return [
    textDisplay(fieldText(field, view.value)),
    actionRow(component),
  ];
}

function renderChannelSelect<Context>(
  field: SettingsChannelSelectField<Context>,
  location: SettingsLocation,
  view: Awaited<ReturnType<SettingsChannelSelectField<Context>["load"]>>,
): readonly APIComponentInContainer[] {
  validateSelectBounds(field.id, undefined, view.minValues, view.maxValues);
  const component: APIChannelSelectComponent = {
    type: ComponentType.ChannelSelect,
    custom_id: encodeFieldRoute("channel-select", location, field.id),
    ...(view.defaultChannelIds === undefined
      ? {}
      : {
          default_values: view.defaultChannelIds.map((id) => ({
            id,
            type: SelectMenuDefaultValueType.Channel,
          })),
        }),
    ...(view.channelTypes === undefined
      ? {}
      : { channel_types: [...view.channelTypes] }),
    ...(view.placeholder === undefined
      ? {}
      : { placeholder: view.placeholder }),
    ...(view.minValues === undefined ? {} : { min_values: view.minValues }),
    ...(view.maxValues === undefined ? {} : { max_values: view.maxValues }),
    ...(view.disabled === undefined ? {} : { disabled: view.disabled }),
  };
  return [
    textDisplay(fieldText(field, view.value)),
    actionRow(component),
  ];
}

function categoryNavigation<Context>(
  categories: readonly SettingsCategory<Context>[],
  location: SettingsLocation,
): APIActionRowComponent<APIStringSelectComponent> {
  return actionRow({
    type: ComponentType.StringSelect,
    custom_id: encodeSettingsCustomId({
      action: "category",
      categoryId: location.categoryId,
      subcategoryId: location.subcategoryId,
      page: location.page,
    }),
    placeholder: "Choose a settings category",
    min_values: 1,
    max_values: 1,
    options: categories.map((category) => ({
      label: category.label,
      value: category.id,
      ...(category.description === undefined
        ? {}
        : { description: truncate(category.description, 100) }),
      ...(category.id === location.categoryId ? { default: true } : {}),
    })),
  });
}

function subcategoryNavigation<Context>(
  category: SettingsCategory<Context>,
  location: SettingsLocation,
): APIActionRowComponent<APIStringSelectComponent> {
  return actionRow({
    type: ComponentType.StringSelect,
    custom_id: encodeSettingsCustomId({
      action: "subcategory",
      categoryId: location.categoryId,
      subcategoryId: location.subcategoryId,
      page: location.page,
    }),
    placeholder: "Choose a settings page",
    min_values: 1,
    max_values: 1,
    options: category.subcategories.map((subcategory) => ({
      label: subcategory.label,
      value: subcategory.id,
      ...(subcategory.description === undefined
        ? {}
        : { description: truncate(subcategory.description, 100) }),
      ...(subcategory.id === location.subcategoryId ? { default: true } : {}),
    })),
  });
}

function pageNavigation(
  location: SettingsLocation,
): APIActionRowComponent<APIButtonComponentWithCustomId> {
  return actionRow(
    navigationButton("Previous", Math.max(0, location.page - 1), location),
    navigationButton(
      `Page ${String(location.page + 1)} of ${String(location.pageCount)}`,
      location.page,
      location,
      true,
    ),
    navigationButton(
      "Next",
      Math.min(location.pageCount - 1, location.page + 1),
      location,
    ),
  );
}

function navigationButton(
  label: string,
  page: number,
  location: SettingsLocation,
  forceDisabled = false,
): APIButtonComponentWithCustomId {
  return {
    type: ComponentType.Button,
    style: ButtonStyle.Secondary,
    label,
    custom_id: encodeSettingsCustomId({
      action: "page",
      categoryId: location.categoryId,
      subcategoryId: location.subcategoryId,
      page,
    }),
    disabled:
      forceDisabled ||
      (label === "Previous" && location.page === 0) ||
      (label === "Next" && location.page === location.pageCount - 1),
  };
}

function buttonSection(
  content: string,
  label: string,
  customId: string,
  style: Exclude<ButtonStyle, ButtonStyle.Link | ButtonStyle.Premium>,
  disabled: boolean | undefined,
): APISectionComponent {
  return {
    type: ComponentType.Section,
    components: [textDisplay(content)],
    accessory: {
      type: ComponentType.Button,
      custom_id: customId,
      style,
      label: truncate(label, 80),
      ...(disabled === undefined ? {} : { disabled }),
    },
  };
}

function actionRow<Component extends APIComponentInMessageActionRow>(
  ...components: Component[]
): APIActionRowComponent<Component> {
  return { type: ComponentType.ActionRow, components };
}

function textDisplay(content: string): APITextDisplayComponent {
  if (content.length > 4_000) {
    throw new SettingsViewError(
      "invalid-view",
      "settings text display exceeds 4000 characters",
    );
  }
  return { type: ComponentType.TextDisplay, content };
}

function renderHeading<Context>(
  title: string,
  category: SettingsCategory<Context>,
  subcategory: SettingsSubcategory<Context>,
): string {
  return [
    `# ${title}`,
    `## ${category.label} · ${subcategory.label}`,
    subcategory.description ?? category.description,
  ]
    .filter((value) => value !== undefined)
    .join("\n");
}

function fieldText<Context>(
  field: SettingsField<Context>,
  value: string | undefined,
): string {
  return [
    `### ${field.label}`,
    field.description,
    value === undefined ? undefined : `**Current:** ${value}`,
  ]
    .filter((part) => part !== undefined)
    .join("\n");
}

function encodeFieldRoute(
  action:
    | "button"
    | "string-select"
    | "mentionable-select"
    | "channel-select"
    | "modal",
  location: SettingsLocation,
  fieldId: string,
): string {
  return encodeSettingsCustomId({
    action,
    categoryId: location.categoryId,
    subcategoryId: location.subcategoryId,
    fieldId,
    page: location.page,
  });
}

function validateSelectBounds(
  fieldId: string,
  optionCount: number | undefined,
  minimum: number | undefined,
  maximum: number | undefined,
): void {
  if (optionCount !== undefined && optionCount > SETTINGS_LIMITS.selectOptions) {
    throw invalidField(
      fieldId,
      `may provide at most ${SETTINGS_LIMITS.selectOptions} options`,
    );
  }
  const effectiveMaximum = maximum ?? 1;
  const effectiveMinimum = minimum ?? 1;
  if (
    !Number.isInteger(effectiveMinimum) ||
    !Number.isInteger(effectiveMaximum) ||
    effectiveMinimum < 0 ||
    effectiveMaximum < 1 ||
    effectiveMaximum > SETTINGS_LIMITS.selectOptions ||
    effectiveMinimum > effectiveMaximum ||
    (optionCount !== undefined && effectiveMaximum > optionCount)
  ) {
    throw invalidField(fieldId, "has invalid select minimum/maximum values");
  }
}

function invalidField(fieldId: string, message: string): SettingsViewError {
  return new SettingsViewError(
    "invalid-view",
    `settings field ${fieldId} ${message}`,
  );
}

function stale(kind: string, id: string): SettingsViewError {
  return new SettingsViewError(
    "stale",
    `settings ${kind} ${JSON.stringify(id)} is unknown or stale`,
  );
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

