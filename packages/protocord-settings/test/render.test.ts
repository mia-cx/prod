import { ButtonStyle, ComponentType } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  createSettingsRenderer,
  type SettingsDefinition,
  type SettingsField,
  type SettingsViewError,
} from "../src/index.js";

type Context = Readonly<{ userId: string }>;

const displayField = (index: number): SettingsField<Context> => ({
  kind: "display",
  id: `field-${String(index)}`,
  label: `Field ${String(index)}`,
  load: () => ({ value: `Value ${String(index)}` }),
});

function customIds(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(customIds);
  if (value === null || typeof value !== "object") return [];
  const record = value as Readonly<Record<string, unknown>>;
  return [
    ...(typeof record.custom_id === "string" ? [record.custom_id] : []),
    ...Object.values(record).flatMap(customIds),
  ];
}

function textDisplayContents(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(textDisplayContents);
  if (value === null || typeof value !== "object") return [];
  const record = value as Readonly<Record<string, unknown>>;
  return [
    ...(record.type === ComponentType.TextDisplay &&
    typeof record.content === "string"
      ? [record.content]
      : []),
    ...Object.values(record).flatMap(textDisplayContents),
  ];
}

const definition = (
  authorize = vi.fn((context: Context) => context.userId === "admin"),
): SettingsDefinition<Context> => ({
  title: "Synthetic settings",
  accentColor: 0x5865f2,
  categories: [
    {
      id: "setup",
      label: "Setup",
      description: "Configure the synthetic consumer.",
      authorize,
      subcategories: [
        {
          id: "general",
          label: "General",
          fields: [
            {
              kind: "button",
              id: "refresh",
              label: "Refresh",
              style: ButtonStyle.Primary,
              load: () => ({ value: "Ready", buttonLabel: "Run" }),
              mutate: () => undefined,
            },
            {
              kind: "string-select",
              id: "mode",
              label: "Mode",
              load: () => ({
                value: "Friendly",
                selectedValues: ["friendly"],
                options: [
                  { label: "Friendly", value: "friendly" },
                  { label: "Direct", value: "direct" },
                ],
              }),
              mutate: () => undefined,
            },
          ],
        },
        {
          id: "large-page",
          label: "Large page",
          fields: Array.from({ length: 15 }, (_, index) => displayField(index)),
        },
      ],
    },
    {
      id: "private",
      label: "Private",
      authorize: () => false,
      subcategories: [
        { id: "hidden", label: "Hidden", fields: [displayField(99)] },
      ],
    },
    {
      id: "labels",
      label: "Labels",
      authorize: () => true,
      subcategories: [
        { id: "active", label: "Active", fields: [displayField(98)] },
      ],
    },
  ],
});

describe("Components v2 settings rendering", () => {
  it("requires explicit category and subcategory selection", async () => {
    const authorize = vi.fn(() => true);
    const renderer = createSettingsRenderer(definition(authorize));

    const homeView = await renderer.render({}, { userId: "admin" });
    const [home] = homeView.components;

    expect(authorize).toHaveBeenCalledOnce();
    expect(homeView.components).toHaveLength(1);
    expect(homeView.location).toEqual({ page: 0, pageCount: 0 });
    expect(JSON.stringify(home)).toContain("Synthetic settings");
    expect(JSON.stringify(home)).toContain("Labels");
    expect(JSON.stringify(home)).not.toContain("Private");
    expect(JSON.stringify(home)).not.toContain("Refresh");
    expect(JSON.stringify(home)).not.toContain('"default":true');

    const categoryView = await renderer.render(
      { categoryId: "setup" },
      { userId: "admin" },
    );
    const [, category] = categoryView.components;
    expect(categoryView.components).toHaveLength(2);
    expect(categoryView.location).toEqual({
      categoryId: "setup",
      page: 0,
      pageCount: 0,
    });
    expect(JSON.stringify(category)).toContain("Setup");
    expect(JSON.stringify(category)).toContain("Large page");
    expect(JSON.stringify(category)).not.toContain("Refresh");
    expect(JSON.stringify(category)).not.toContain('"default":true');

    const view = await renderer.render(
      { categoryId: "setup", subcategoryId: "general" },
      { userId: "admin" },
    );
    const [, , subcategory] = view.components;
    expect(view.components).toHaveLength(3);
    for (const container of view.components) {
      expect(container).toMatchObject({
        type: ComponentType.Container,
        accent_color: 0x5865f2,
      });
    }
    expect(JSON.stringify(subcategory)).toContain("General");
    expect(JSON.stringify(subcategory)).toContain("Refresh");
    expect(JSON.stringify(subcategory)).toContain("Friendly");
    expect(view.location).toEqual({
      categoryId: "setup",
      subcategoryId: "general",
      page: 0,
      pageCount: 1,
    });
  });

  it("falls back to field labels for empty dynamic button labels", async () => {
    const renderer = createSettingsRenderer({
      title: "Button labels",
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
                  kind: "button",
                  id: "action",
                  label: "Action fallback",
                  load: () => ({ value: "Ready", buttonLabel: "" }),
                  mutate: () => undefined,
                },
                {
                  kind: "modal",
                  id: "form",
                  label: "Form fallback",
                  title: "Form",
                  inputs: [{ id: "value", label: "Value" }],
                  load: () => ({ value: "Ready", buttonLabel: "" }),
                  mutate: () => undefined,
                },
              ],
            },
          ],
        },
      ],
    });

    const view = await renderer.render(
      { categoryId: "setup", subcategoryId: "general" },
      { userId: "admin" },
    );
    const payload = JSON.stringify(view.components);

    expect(payload).toContain('"label":"Action fallback"');
    expect(payload).toContain('"label":"Form fallback"');
  });

  it("paginates fields without exceeding Discord container limits", async () => {
    const renderer = createSettingsRenderer(definition());

    const first = await renderer.render(
      { categoryId: "setup", subcategoryId: "large-page", page: 0 },
      { userId: "admin" },
    );
    const second = await renderer.render(
      { categoryId: "setup", subcategoryId: "large-page", page: 1 },
      { userId: "admin" },
    );
    const third = await renderer.render(
      { categoryId: "setup", subcategoryId: "large-page", page: 2 },
      { userId: "admin" },
    );
    const firstContainer = first.components[2];
    const secondContainer = second.components[2];
    const thirdContainer = third.components[2];

    expect(first.location.pageCount).toBe(3);
    expect(firstContainer?.type).toBe(ComponentType.Container);
    expect(
      firstContainer?.type === ComponentType.Container
        ? firstContainer.components.length
        : 0,
    ).toBeLessThanOrEqual(10);
    expect(JSON.stringify(firstContainer)).toContain("Page 1 of 3");
    expect(JSON.stringify(secondContainer)).toContain("Page 2 of 3");
    expect(JSON.stringify(thirdContainer)).toContain("Page 3 of 3");
    expect(JSON.stringify(firstContainer)).toContain("Field 0");
    expect(JSON.stringify(thirdContainer)).toContain("Field 14");
    for (const view of [first, third]) {
      const ids = customIds(view.components);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("keeps page routes stable while transient notices are rendered", async () => {
    const value: SettingsDefinition<Context> = {
      title: "Stable pages",
      categories: [
        {
          id: "only",
          label: "Only",
          authorize: () => true,
          subcategories: [
            {
              id: "page",
              label: "Page",
              fields: Array.from({ length: 16 }, (_, index) =>
                displayField(index),
              ),
            },
          ],
        },
      ],
    };
    const renderer = createSettingsRenderer(value);

    const ordinary = await renderer.render({ page: 1 }, { userId: "admin" });
    const withNotice = await renderer.render(
      { page: 1, notice: { kind: "success", message: "Saved" } },
      { userId: "admin" },
    );

    expect(withNotice.location.pageCount).toBe(ordinary.location.pageCount);
    expect(withNotice.location.page).toBe(ordinary.location.page);
  });

  it("keeps page routes stable when unrelated category access changes", async () => {
    let canViewOtherCategory = true;
    const value: SettingsDefinition<Context> = {
      title: "Stable authorized pages",
      categories: [
        {
          id: "main",
          label: "Main",
          authorize: () => true,
          subcategories: [
            {
              id: "page",
              label: "Page",
              fields: Array.from({ length: 13 }, (_, index) =>
                displayField(index),
              ),
            },
          ],
        },
        {
          id: "other",
          label: "Other",
          authorize: () => canViewOtherCategory,
          subcategories: [
            { id: "other-page", label: "Other page", fields: [] },
          ],
        },
      ],
    };
    const renderer = createSettingsRenderer(value);
    const before = await renderer.render(
      { categoryId: "main", subcategoryId: "page", page: 1 },
      { userId: "admin" },
    );

    canViewOtherCategory = false;
    const after = await renderer.render(
      { categoryId: "main", subcategoryId: "page", page: 1 },
      { userId: "admin" },
    );

    expect(after.location).toEqual(before.location);
    expect(JSON.stringify(after.components)).toContain("Field 12");
  });

  it("rejects unauthorized, stale, and out-of-range views", async () => {
    const renderer = createSettingsRenderer(definition());

    await expect(
      renderer.render({ categoryId: "private" }, { userId: "admin" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SettingsViewError>>({
        reason: "unauthorized",
      }),
    );
    await expect(
      renderer.render({ categoryId: "missing" }, { userId: "admin" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SettingsViewError>>({ reason: "stale" }),
    );
    await expect(
      renderer.render(
        { categoryId: "setup", subcategoryId: "large-page", page: 99 },
        { userId: "admin" },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SettingsViewError>>({ reason: "stale" }),
    );
  });

  it("enforces dynamic select-option limits", async () => {
    const value = definition();
    const setup = value.categories[0]!;
    const general = setup.subcategories[0]!;
    const oversized: SettingsDefinition<Context> = {
      ...value,
      categories: [
        {
          ...setup,
          subcategories: [
            {
              ...general,
              fields: [
                {
                  kind: "string-select",
                  id: "too-many",
                  label: "Too many",
                  load: () => ({
                    options: Array.from({ length: 26 }, (_, index) => ({
                      label: String(index),
                      value: String(index),
                    })),
                  }),
                  mutate: () => undefined,
                },
              ],
            },
          ],
        },
      ],
    };

    await expect(
      createSettingsRenderer(oversized).render(
        { categoryId: "setup", subcategoryId: "general" },
        { userId: "admin" },
      ),
    ).rejects.toThrow(/at most 25 options/);
  });

  it("rejects select payloads that Discord would reject", async () => {
    const value = definition();
    const setup = value.categories[0]!;
    const general = setup.subcategories[0]!;
    const withField = (
      field: SettingsField<Context>,
    ): SettingsDefinition<Context> => ({
      ...value,
      categories: [
        {
          ...setup,
          subcategories: [{ ...general, fields: [field] }],
        },
      ],
    });

    await expect(
      createSettingsRenderer(
        withField({
          kind: "string-select",
          id: "invalid-string",
          label: "Invalid string",
          load: () => ({
            placeholder: "p".repeat(151),
            options: [{ label: "l".repeat(101), value: "valid" }],
          }),
          mutate: () => undefined,
        }),
      ).render(
        { categoryId: "setup", subcategoryId: "general" },
        { userId: "admin" },
      ),
    ).rejects.toThrow(/placeholder|label/);

    await expect(
      createSettingsRenderer(
        withField({
          kind: "mentionable-select",
          id: "invalid-defaults",
          label: "Invalid defaults",
          load: () => ({
            maxValues: 1,
            defaults: [
              { kind: "user", id: "12345678901234567" },
              { kind: "role", id: "22345678901234567" },
            ],
          }),
          mutate: () => undefined,
        }),
      ).render(
        { categoryId: "setup", subcategoryId: "general" },
        { userId: "admin" },
      ),
    ).rejects.toThrow(/default/i);
  });

  it("omits semantically empty defaults for an optional select", async () => {
    const value = definition();
    const setup = value.categories[0]!;
    const general = setup.subcategories[0]!;
    const renderer = createSettingsRenderer({
      ...value,
      categories: [
        {
          ...setup,
          subcategories: [
            {
              ...general,
              fields: [
                {
                  kind: "mentionable-select",
                  id: "optional",
                  label: "Optional",
                  load: () => ({ minValues: 0, defaults: [] }),
                  mutate: () => undefined,
                },
              ],
            },
          ],
        },
      ],
    });

    const rendered = await renderer.render(
      { categoryId: "setup", subcategoryId: "general" },
      { userId: "admin" },
    );

    expect(JSON.stringify(rendered.components)).not.toContain("default_values");
  });

  it("fits composed text displays within Discord's shared message budget", async () => {
    const renderer = createSettingsRenderer({
      title: "Text budgets",
      categories: [
        {
          id: "category",
          label: "Category heading",
          description: "c".repeat(4_000),
          authorize: () => true,
          subcategories: [
            {
              id: "subcategory",
              label: "Subcategory heading",
              description: "s".repeat(4_000),
              fields: [
                {
                  kind: "display",
                  id: "field",
                  label: "Field heading",
                  description: "d".repeat(4_000),
                  load: () => ({ value: "v".repeat(4_000) }),
                },
              ],
            },
          ],
        },
      ],
    });

    const rendered = await renderer.render(
      { categoryId: "category", subcategoryId: "subcategory" },
      { userId: "admin" },
    );
    const contents = textDisplayContents(rendered.components);

    expect(contents).toHaveLength(4);
    expect(contents.every((content) => content.length <= 4_000)).toBe(true);
    expect(contents.reduce((total, content) => total + content.length, 0)).toBe(
      4_000,
    );
    expect(contents).toEqual([
      expect.stringContaining("Text budgets"),
      expect.stringContaining("Category heading"),
      expect.stringContaining("Subcategory heading"),
      expect.stringContaining("Field heading"),
    ]);
  });

  it("preserves text displays when their combined content fits the budget", async () => {
    const categoryDescription = "c".repeat(3_000);
    const renderer = createSettingsRenderer({
      title: "Under budget",
      categories: [
        {
          id: "category",
          label: "Category",
          description: categoryDescription,
          authorize: () => true,
          subcategories: [
            {
              id: "subcategory",
              label: "Subcategory",
              fields: [displayField(1)],
            },
          ],
        },
      ],
    });

    const rendered = await renderer.render(
      { categoryId: "category", subcategoryId: "subcategory" },
      { userId: "admin" },
    );
    const contents = textDisplayContents(rendered.components);

    expect(contents[1]).toBe(`# Category\n${categoryDescription}`);
    expect(contents.reduce((total, content) => total + content.length, 0)).toBeLessThan(
      4_000,
    );
  });
});
