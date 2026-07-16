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
          fields: Array.from({ length: 12 }, (_, index) => displayField(index)),
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
  it("renders only authorized category navigation and consumer fields", async () => {
    const authorize = vi.fn(() => true);
    const renderer = createSettingsRenderer(definition(authorize));

    const view = await renderer.render({}, { userId: "admin" });
    const container = view.components[0];

    expect(authorize).toHaveBeenCalledOnce();
    expect(container).toMatchObject({
      type: ComponentType.Container,
      accent_color: 0x5865f2,
    });
    expect(JSON.stringify(container)).toContain("Synthetic settings");
    expect(JSON.stringify(container)).toContain("Refresh");
    expect(JSON.stringify(container)).toContain("Friendly");
    expect(JSON.stringify(container)).not.toContain("Private");
    expect(view.location).toEqual({
      categoryId: "setup",
      subcategoryId: "general",
      page: 0,
      pageCount: 1,
    });
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
    const firstContainer = first.components[0];
    const secondContainer = second.components[0];
    const thirdContainer = third.components[0];

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
    expect(JSON.stringify(thirdContainer)).toContain("Field 11");
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
      { categoryId: "main", subcategoryId: "page", page: 2 },
      { userId: "admin" },
    );

    canViewOtherCategory = false;
    const after = await renderer.render(
      { categoryId: "main", subcategoryId: "page", page: 2 },
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
      createSettingsRenderer(oversized).render({}, { userId: "admin" }),
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
      ).render({}, { userId: "admin" }),
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
      ).render({}, { userId: "admin" }),
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

    const rendered = await renderer.render({}, { userId: "admin" });

    expect(JSON.stringify(rendered.components)).not.toContain("default_values");
  });
});
