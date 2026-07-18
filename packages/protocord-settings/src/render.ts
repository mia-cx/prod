import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacingSize,
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
  type APISeparatorComponent,
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
import {
  categoryPages,
  isDirectSettingsCategory,
} from "./category-layout.js";
import { SETTINGS_LIMITS, validateSettingsDefinition } from "./definition.js";
import { encodeSettingsCustomId } from "./routes.js";
import {
  assertSelectionCount,
  resolveSelectBounds,
  SettingsSelectConstraintError,
} from "./select-constraints.js";

export type SettingsLocation = Readonly<{
  categoryId?: string;
  subcategoryId?: string;
  page: number;
  pageCount: number;
}>;

type ResolvedSettingsLocation = Readonly<{
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
  homePage?: number;
  subcategoryPage?: number;
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

  const routeCategory = authorizedCategories[0]!;
  const routeSubcategory = categoryPages(routeCategory)[0]!;
  const homePageCount = Math.ceil(
    authorizedCategories.length / SETTINGS_LIMITS.categoriesPerHomePage,
  );
  const requestedHomePage = request.homePage ?? 0;
  const homeCategories = authorizedCategories.slice(
    requestedHomePage * SETTINGS_LIMITS.categoriesPerHomePage,
    (requestedHomePage + 1) * SETTINGS_LIMITS.categoriesPerHomePage,
  );
  if (homeCategories.length === 0) {
    throw stale("category page", String(requestedHomePage));
  }
  const homeChildren: APIComponentInContainer[] = [
    textDisplay(`# ${definition.title}`),
    textDisplay(categorySummaryList(homeCategories)),
  ];
  if (homePageCount > 1) {
    homeChildren.push(
      homePageNavigation(
        requestedHomePage,
        homePageCount,
        routeCategory.id,
        routeSubcategory.id,
      ),
    );
  }
  homeChildren.push(
    separator(),
    textDisplay("Choose a category"),
    categoryNavigation(
      authorizedCategories,
      request.categoryId,
      routeCategory.id,
      routeSubcategory.id,
    ),
  );
  if (request.categoryId === undefined) {
    const components = [
      container("home", homeChildren, definition.accentColor),
    ];
    constrainTextDisplays(components);
    return {
      components,
      location: { page: requestedHomePage, pageCount: homePageCount },
    };
  }

  const requestedCategory = definition.categories.find(
    ({ id }) => id === request.categoryId,
  );
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

  const directCategory = isDirectSettingsCategory(category);
  const categoryChildren: APIComponentInContainer[] = [
    textDisplay(nodeHeading(category.label, category.description)),
  ];
  if (!directCategory) {
    const subcategories = categoryPages(category);
    const subcategoryPageCount = Math.ceil(
      subcategories.length / SETTINGS_LIMITS.subcategoriesPerOverviewPage,
    );
    const requestedSubcategoryPage = request.subcategoryPage ?? 0;
    const overviewSubcategories = subcategories.slice(
      requestedSubcategoryPage * SETTINGS_LIMITS.subcategoriesPerOverviewPage,
      (requestedSubcategoryPage + 1) *
        SETTINGS_LIMITS.subcategoriesPerOverviewPage,
    );
    if (overviewSubcategories.length === 0) {
      throw stale("subcategory page", String(requestedSubcategoryPage));
    }
    categoryChildren.push(
      textDisplay(subcategorySummaryList(overviewSubcategories)),
    );
    if (subcategoryPageCount > 1) {
      categoryChildren.push(
        subcategoryPageNavigation(
          requestedSubcategoryPage,
          subcategoryPageCount,
          category.id,
          subcategories[0]!.id,
        ),
      );
    }
    categoryChildren.push(
      separator(),
      textDisplay("Choose a settings page"),
      subcategoryNavigation(category, request.subcategoryId),
    );
  } else {
    categoryChildren.push(separator());
  }
  if (!directCategory && request.subcategoryId === undefined) {
    const components = [
      container("home", homeChildren, definition.accentColor),
      container("category", categoryChildren, definition.accentColor),
    ];
    constrainTextDisplays(components);
    return {
      components,
      location: { categoryId: category.id, page: 0, pageCount: 0 },
    };
  }

  const subcategory = selectSubcategory(
    category,
    request.subcategoryId ?? category.id,
  );
  const fieldPages = paginateFields(subcategory.fields, fixedComponentCount());
  const requestedPage = request.page ?? 0;
  const fields = fieldPages[requestedPage];
  if (fields === undefined) {
    throw stale("page", String(requestedPage));
  }

  const location: ResolvedSettingsLocation = {
    categoryId: category.id,
    subcategoryId: subcategory.id,
    page: requestedPage,
    pageCount: fieldPages.length,
  };
  const fieldChildren: APIComponentInContainer[] = directCategory
    ? categoryChildren
    : [textDisplay(nodeHeading(subcategory.label, subcategory.description))];
  if (request.notice !== undefined) {
    const marker = request.notice.kind === "success" ? "✅" : "⚠️";
    fieldChildren.push(
      textDisplay(truncate(`${marker} ${request.notice.message}`, 4_000)),
    );
  }
  for (const field of fields) {
    fieldChildren.push(...(await renderField(field, location, context)));
  }
  if (fieldPages.length > 1) {
    fieldChildren.push(pageNavigation(location));
  }
  const components: APIMessageTopLevelComponent[] = [
    container("home", homeChildren, definition.accentColor),
    ...(directCategory
      ? [container("category", fieldChildren, definition.accentColor)]
      : [
          container("category", categoryChildren, definition.accentColor),
          container(
            "subcategory",
            fieldChildren,
            definition.accentColor,
          ),
        ]),
  ];
  constrainTextDisplays(components);
  return {
    components,
    location,
  };
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
  requestedId: string,
): SettingsSubcategory<Context> {
  const subcategory = categoryPages(category).find(
    ({ id }) => id === requestedId,
  );
  if (subcategory === undefined) {
    throw stale("subcategory", requestedId);
  }
  return subcategory;
}

function fixedComponentCount(): number {
  return 2;
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
  if (field.kind === "modal" && field.presentation?.kind === "preview") {
    return 2;
  }
  return ["string-select", "mentionable-select", "channel-select"].includes(
    field.kind,
  )
    ? 2
    : 1;
}

async function renderField<Context>(
  field: SettingsField<Context>,
  location: ResolvedSettingsLocation,
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
          view.buttonLabel || field.label,
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
  location: ResolvedSettingsLocation,
  view: Awaited<ReturnType<SettingsModalField<Context>["load"]>>,
): readonly APIComponentInContainer[] {
  const buttonLabel = view.buttonLabel || field.label;
  const customId = encodeFieldRoute("modal", location, field.id);
  if (field.presentation?.kind === "inline") {
    return [
      buttonSection(
        `**${field.label}:**${view.value === undefined ? "" : ` ${view.value}`}`,
        buttonLabel,
        customId,
        ButtonStyle.Secondary,
        view.disabled,
      ),
    ];
  }
  if (field.presentation?.kind === "preview") {
    return [
      buttonSection(
        `**${field.label}**`,
        buttonLabel,
        customId,
        ButtonStyle.Secondary,
        view.disabled,
      ),
      textDisplay(truncate(view.value ?? "", field.presentation.maxLength)),
    ];
  }
  return [
    buttonSection(
      fieldText(field, view.value),
      buttonLabel,
      customId,
      ButtonStyle.Secondary,
      view.disabled,
    ),
  ];
}

function renderStringSelect<Context>(
  field: SettingsStringSelectField<Context>,
  location: ResolvedSettingsLocation,
  view: Awaited<ReturnType<SettingsStringSelectField<Context>["load"]>>,
): readonly APIComponentInContainer[] {
  const bounds = selectBounds(field.id, view.options.length, view);
  if (view.options.length === 0) {
    throw invalidField(field.id, "must provide at least one option");
  }
  const optionValues = new Set<string>();
  for (const option of view.options) {
    validateDynamicText(field.id, "option label", option.label, 100);
    validateDynamicText(field.id, "option value", option.value, 100);
    if (option.description !== undefined) {
      validateDynamicText(
        field.id,
        "option description",
        option.description,
        100,
      );
    }
    if (optionValues.has(option.value)) {
      throw invalidField(field.id, `has duplicate option value ${option.value}`);
    }
    optionValues.add(option.value);
  }
  validatePlaceholder(field.id, view.placeholder);
  for (const value of view.selectedValues ?? []) {
    if (!optionValues.has(value)) {
      throw invalidField(field.id, `selects unknown option ${value}`);
    }
  }
  const selectedValues = new Set(view.selectedValues ?? []);
  for (const option of view.options) {
    if (option.default === true) {
      selectedValues.add(option.value);
    }
  }
  assertDefaultSelectionCount(field.id, selectedValues.size, bounds);
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
  location: ResolvedSettingsLocation,
  view: Awaited<ReturnType<SettingsMentionableSelectField<Context>["load"]>>,
): readonly APIComponentInContainer[] {
  const bounds = selectBounds(field.id, undefined, view);
  validatePlaceholder(field.id, view.placeholder);
  validateDefaultIds(
    field.id,
    view.defaults?.map(({ id }) => id) ?? [],
    bounds,
  );
  const defaults = view.defaults?.length ? view.defaults : undefined;
  const component: APIMentionableSelectComponent = {
    type: ComponentType.MentionableSelect,
    custom_id: encodeFieldRoute("mentionable-select", location, field.id),
    ...(defaults === undefined
      ? {}
      : {
          default_values: defaults.map((value) => ({
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
  location: ResolvedSettingsLocation,
  view: Awaited<ReturnType<SettingsChannelSelectField<Context>["load"]>>,
): readonly APIComponentInContainer[] {
  const bounds = selectBounds(field.id, undefined, view);
  validatePlaceholder(field.id, view.placeholder);
  validateDefaultIds(field.id, view.defaultChannelIds ?? [], bounds);
  const defaultChannelIds = view.defaultChannelIds?.length
    ? view.defaultChannelIds
    : undefined;
  const component: APIChannelSelectComponent = {
    type: ComponentType.ChannelSelect,
    custom_id: encodeFieldRoute("channel-select", location, field.id),
    ...(defaultChannelIds === undefined
      ? {}
      : {
          default_values: defaultChannelIds.map((id) => ({
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
  selectedCategoryId: string | undefined,
  routeCategoryId: string,
  routeSubcategoryId: string,
): APIActionRowComponent<APIStringSelectComponent> {
  return actionRow({
    type: ComponentType.StringSelect,
    custom_id: encodeSettingsCustomId({
      action: "category",
      categoryId: routeCategoryId,
      subcategoryId: routeSubcategoryId,
      page: 0,
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
      ...(category.id === selectedCategoryId ? { default: true } : {}),
    })),
  });
}

function subcategoryNavigation<Context>(
  category: SettingsCategory<Context>,
  selectedSubcategoryId: string | undefined,
): APIActionRowComponent<APIStringSelectComponent> {
  const subcategories = categoryPages(category);
  const routeSubcategory = subcategories[0]!;
  return actionRow({
    type: ComponentType.StringSelect,
    custom_id: encodeSettingsCustomId({
      action: "subcategory",
      categoryId: category.id,
      subcategoryId: routeSubcategory.id,
      page: 0,
    }),
    placeholder: "Choose a settings page",
    min_values: 1,
    max_values: 1,
    options: subcategories.map((subcategory) => ({
      label: subcategory.label,
      value: subcategory.id,
      ...(subcategory.description === undefined
        ? {}
        : { description: truncate(subcategory.description, 100) }),
      ...(subcategory.id === selectedSubcategoryId ? { default: true } : {}),
    })),
  });
}

function pageNavigation(
  location: ResolvedSettingsLocation,
): APIActionRowComponent<APIButtonComponentWithCustomId> {
  return actionRow(
    navigationButton(
      "Previous",
      location.page === 0 ? location.pageCount : location.page - 1,
      location,
    ),
    navigationButton(
      `Page ${String(location.page + 1)} of ${String(location.pageCount)}`,
      location.page,
      location,
      true,
    ),
    navigationButton(
      "Next",
      location.page === location.pageCount - 1
        ? location.pageCount + 1
        : location.page + 1,
      location,
    ),
  );
}

function homePageNavigation(
  page: number,
  pageCount: number,
  routeCategoryId: string,
  routeSubcategoryId: string,
): APIActionRowComponent<APIButtonComponentWithCustomId> {
  const button = (
    label: string,
    targetPage: number,
    disabled: boolean,
  ): APIButtonComponentWithCustomId => ({
    type: ComponentType.Button,
    style: ButtonStyle.Secondary,
    label,
    custom_id: encodeSettingsCustomId({
      action: "home-page",
      categoryId: routeCategoryId,
      subcategoryId: routeSubcategoryId,
      page: targetPage,
    }),
    disabled,
  });
  return actionRow(
    button("Previous", page === 0 ? 0 : page - 1, page === 0),
    button(
      `Page ${String(page + 1)} of ${String(pageCount)}`,
      page,
      true,
    ),
    button(
      "Next",
      page === pageCount - 1 ? page : page + 1,
      page === pageCount - 1,
    ),
  );
}

function subcategoryPageNavigation(
  page: number,
  pageCount: number,
  categoryId: string,
  routeSubcategoryId: string,
): APIActionRowComponent<APIButtonComponentWithCustomId> {
  const button = (
    label: string,
    targetPage: number,
    disabled: boolean,
  ): APIButtonComponentWithCustomId => ({
    type: ComponentType.Button,
    style: ButtonStyle.Secondary,
    label,
    custom_id: encodeSettingsCustomId({
      action: "subcategory-page",
      categoryId,
      subcategoryId: routeSubcategoryId,
      page: targetPage,
    }),
    disabled,
  });
  return actionRow(
    button("Previous", page === 0 ? 0 : page - 1, page === 0),
    button(
      `Page ${String(page + 1)} of ${String(pageCount)}`,
      page,
      true,
    ),
    button(
      "Next",
      page === pageCount - 1 ? page : page + 1,
      page === pageCount - 1,
    ),
  );
}

function navigationButton(
  label: string,
  page: number,
  location: ResolvedSettingsLocation,
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

function container(
  label: "home" | "category" | "subcategory",
  components: APIComponentInContainer[],
  accentColor: number | undefined,
): APIContainerComponent {
  if (components.length > SETTINGS_LIMITS.containerComponents) {
    throw new SettingsViewError(
      "invalid-view",
      `settings ${label} container exceeds ${SETTINGS_LIMITS.containerComponents} components`,
    );
  }
  return {
    type: ComponentType.Container,
    ...(accentColor === undefined ? {} : { accent_color: accentColor }),
    components,
  };
}

function textDisplay(content: string): APITextDisplayComponent {
  return {
    type: ComponentType.TextDisplay,
    content: truncate(content, SETTINGS_LIMITS.textDisplayCharacters),
  };
}

function separator(): APISeparatorComponent {
  return {
    type: ComponentType.Separator,
    divider: true,
    spacing: SeparatorSpacingSize.Small,
  };
}

function constrainTextDisplays(
  components: readonly APIMessageTopLevelComponent[],
): void {
  const displays = findTextDisplays(components);
  const budget = SETTINGS_LIMITS.textDisplayCharactersPerMessage;
  if (
    displays.reduce((total, display) => total + display.content.length, 0) <=
    budget
  ) {
    return;
  }

  const byLength = displays
    .map((display, index) => ({ display, index }))
    .sort(
      (left, right) =>
        left.display.content.length - right.display.content.length ||
        left.index - right.index,
    );
  let remaining = budget;
  let firstOverflow = 0;
  while (firstOverflow < byLength.length) {
    const candidate = byLength[firstOverflow]!;
    const fairShare = Math.floor(
      remaining / (byLength.length - firstOverflow),
    );
    if (candidate.display.content.length > fairShare) break;
    remaining -= candidate.display.content.length;
    firstOverflow += 1;
  }

  const overflowing = byLength.slice(firstOverflow);
  const fairShare = Math.floor(remaining / overflowing.length);
  let remainder = remaining % overflowing.length;
  for (const { display } of overflowing) {
    const maximum = fairShare + (remainder > 0 ? 1 : 0);
    display.content = truncate(display.content, maximum);
    remainder = Math.max(0, remainder - 1);
  }
}

function findTextDisplays(value: unknown): APITextDisplayComponent[] {
  if (Array.isArray(value)) return value.flatMap(findTextDisplays);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (
    record.type === ComponentType.TextDisplay &&
    typeof record.content === "string"
  ) {
    return [record as unknown as APITextDisplayComponent];
  }
  return Object.values(record).flatMap(findTextDisplays);
}

function nodeHeading(label: string, description: string | undefined): string {
  return [`# ${label}`, description]
    .filter((value) => value !== undefined)
    .join("\n");
}

function categorySummaryList<Context>(
  categories: readonly SettingsCategory<Context>[],
): string {
  return [
    ...categories.map((category) =>
      category.description === undefined
        ? `**${category.label}**`
        : `**${category.label}:** ${truncate(
            category.description,
            SETTINGS_LIMITS.categorySummaryCharacters,
          )}`,
    ),
  ].join("\n");
}

function subcategorySummaryList<Context>(
  subcategories: readonly SettingsSubcategory<Context>[],
): string {
  return subcategories
    .map((subcategory) =>
      subcategory.description === undefined
        ? `**${subcategory.label}**`
        : `**${subcategory.label}:** ${truncate(
            subcategory.description,
            SETTINGS_LIMITS.categorySummaryCharacters,
          )}`,
    )
    .join("\n");
}

function fieldText<Context>(
  field: SettingsField<Context>,
  value: string | undefined,
): string {
  const stateIsRenderedByControl =
    field.kind === "string-select" ||
    field.kind === "mentionable-select" ||
    field.kind === "channel-select";
  return [
    `## ${field.label}`,
    value === undefined || stateIsRenderedByControl
      ? undefined
      : `**Current:** ${value}`,
    field.description,
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
  location: ResolvedSettingsLocation,
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

function selectBounds(
  fieldId: string,
  optionCount: number | undefined,
  view: Readonly<{ minValues?: number; maxValues?: number }>,
) {
  try {
    return resolveSelectBounds({
      fieldId,
      ...(optionCount === undefined ? {} : { optionCount }),
      ...(view.minValues === undefined ? {} : { minimum: view.minValues }),
      ...(view.maxValues === undefined ? {} : { maximum: view.maxValues }),
    });
  } catch (error) {
    if (error instanceof SettingsSelectConstraintError) {
      throw new SettingsViewError("invalid-view", error.message);
    }
    throw error;
  }
}

function assertDefaultSelectionCount(
  fieldId: string,
  count: number,
  bounds: ReturnType<typeof resolveSelectBounds>,
): void {
  try {
    assertSelectionCount(fieldId, count, bounds, "default selection", true);
  } catch (error) {
    if (error instanceof SettingsSelectConstraintError) {
      throw new SettingsViewError("invalid-view", error.message);
    }
    throw error;
  }
}

function validateDefaultIds(
  fieldId: string,
  ids: readonly string[],
  bounds: ReturnType<typeof resolveSelectBounds>,
): void {
  assertDefaultSelectionCount(fieldId, ids.length, bounds);
  const seen = new Set<string>();
  for (const id of ids) {
    if (!/^\d{17,20}$/.test(id)) {
      throw invalidField(fieldId, `has invalid default ID ${id}`);
    }
    if (seen.has(id)) {
      throw invalidField(fieldId, `has duplicate default ID ${id}`);
    }
    seen.add(id);
  }
}

function validatePlaceholder(
  fieldId: string,
  placeholder: string | undefined,
): void {
  if (placeholder !== undefined) {
    validateDynamicText(fieldId, "placeholder", placeholder, 150);
  }
}

function validateDynamicText(
  fieldId: string,
  label: string,
  value: string,
  maximum: number,
): void {
  if (value.length < 1 || value.length > maximum) {
    throw invalidField(
      fieldId,
      `${label} must contain between 1 and ${String(maximum)} characters`,
    );
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
