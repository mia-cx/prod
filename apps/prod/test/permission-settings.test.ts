import { describe, expect, it, vi } from "vitest";
import {
  createSettingsRenderer,
  type SettingsField,
  type SettingsMentionable,
} from "@protocord/settings";

import {
  createPermissionSettingsCategory,
  type PermissionSettingsContext,
} from "../src/actions/permission-settings.js";
import type {
  PermissionAdministrationService,
  PermissionPreset,
  PermissionSubject,
} from "../src/permission-administration.js";

type Context = PermissionSettingsContext;

const context: Context = {
  guildId: "guild-1",
  userId: "admin-1",
  settingsSessionId: "message-1",
};

const setup = (initialSubjects: readonly PermissionSubject[] = []) => {
  const subjects = new Map<PermissionPreset, readonly PermissionSubject[]>([
    ["support_staff", initialSubjects],
    ["assignment_manager", []],
    ["configurator", []],
  ]);
  const updatePresetSubjects = vi.fn(
    async (input: {
      preset: PermissionPreset;
      add: readonly PermissionSubject[];
      remove: readonly PermissionSubject[];
    }) => {
      const updated = new Map(
        (subjects.get(input.preset) ?? []).map((subject) => [
          `${subject.subjectType}:${subject.subjectId}`,
          subject,
        ]),
      );
      for (const subject of input.remove) {
        updated.delete(`${subject.subjectType}:${subject.subjectId}`);
      }
      for (const subject of input.add) {
        updated.set(`${subject.subjectType}:${subject.subjectId}`, subject);
      }
      subjects.set(input.preset, [...updated.values()]);
    },
  );
  const service: PermissionAdministrationService = {
    listPresetSubjects: async (_guildId, preset) => subjects.get(preset) ?? [],
    setPresetSubjects: async () => undefined,
    updatePresetSubjects,
    applyCustomRules: async () => undefined,
    listRules: async ({ offset = 0, limit = 10 }) => ({
      items: [],
      total: 0,
      offset,
      limit,
    }),
    removeRule: async () => undefined,
  };
  const category = createPermissionSettingsCategory<Context>({
    service,
    authorize: () => true,
    requireAuthorization: async () => undefined,
  });
  return { category, updatePresetSubjects };
};

const field = (
  category: ReturnType<typeof setup>["category"],
  fieldId: PermissionPreset,
): SettingsField<Context> => {
  const found = category.fields?.find(({ id }) => id === fieldId);
  if (found === undefined) throw new Error(`Missing ${fieldId}`);
  return found;
};

const mentionables: readonly SettingsMentionable[] = [
  {
    kind: "user",
    id: "user-1",
    user: { id: "user-1", username: "mia", globalName: "Mia" },
  },
  {
    kind: "role",
    id: "role-1",
    role: { id: "role-1", name: "Support" },
  },
];

describe("permission settings category", () => {
  it("renders one direct page with three native mentionable selects", async () => {
    const { category } = setup();
    const renderer = createSettingsRenderer({
      title: "Prod settings",
      categories: [category],
    });

    const rendered = await renderer.render(
      { categoryId: "permissions" },
      context,
    );
    const payload = JSON.stringify(rendered.components);

    expect(rendered.location).toEqual({
      categoryId: "permissions",
      subcategoryId: "permissions",
      page: 0,
      pageCount: 1,
    });
    expect(category.fields?.map(({ id }) => id)).toEqual([
      "support_staff",
      "assignment_manager",
      "configurator",
    ]);
    expect(category.subcategories).toBeUndefined();
    expect(payload).toContain("Support staff");
    expect(payload).toContain("Assignment managers");
    expect(payload).toContain("Configurators");
    expect(payload).not.toContain("Advanced");
    expect(payload).not.toContain("Inspect");
    expect(payload).not.toContain("rules");
  });

  it("edits users and roles through one preset mentionable control", async () => {
    const { category, updatePresetSubjects } = setup([
      { subjectType: "role", subjectId: "role-1" },
    ]);
    const subjects = field(category, "support_staff");
    if (subjects.kind !== "mentionable-select") {
      throw new Error("Expected mentionable select");
    }

    expect(await subjects.load(context)).toMatchObject({
      defaults: [{ kind: "role", id: "role-1" }],
      minValues: 0,
      maxValues: 25,
    });
    await subjects.mutate([mentionables[0]!], context);

    expect(updatePresetSubjects).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        preset: "support_staff",
        add: [{ subjectType: "user", subjectId: "user-1" }],
        remove: [{ subjectType: "role", subjectId: "role-1" }],
        actorUserId: "admin-1",
      }),
    );
  });

  it("encodes explicit subject types in the native preset selector", async () => {
    const initial = Array.from({ length: 2 }, (_, index) => ({
      subjectType: index % 2 === 0 ? ("user" as const) : ("role" as const),
      subjectId: `12345678901234567${String(index)}`,
    }));
    const { category } = setup(initial);
    const renderer = createSettingsRenderer({
      title: "Prod settings",
      categories: [category],
    });

    const rendered = await renderer.render(
      { categoryId: "permissions" },
      context,
    );
    const payload = JSON.stringify(rendered.components);

    expect(payload).toContain(
      '"default_values":[{"id":"123456789012345670","type":"user"},{"id":"123456789012345671","type":"role"}]',
    );
    expect(payload).not.toContain("Current subjects");
    expect(payload).not.toContain("configured");
  });

  it("clears a preset by removing every mentionable selection", async () => {
    const { category, updatePresetSubjects } = setup([
      { subjectType: "role", subjectId: "role-1" },
    ]);
    const subjects = field(category, "support_staff");
    if (subjects.kind !== "mentionable-select") {
      throw new Error("Expected mentionable select");
    }

    await subjects.load(context);
    await subjects.mutate([], context);
    expect(updatePresetSubjects).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        preset: "support_staff",
        add: [],
        remove: [{ subjectType: "role", subjectId: "role-1" }],
        actorUserId: "admin-1",
      }),
    );
  });

  it("preserves unseen additions from another settings message", async () => {
    const initial = { subjectType: "role" as const, subjectId: "role-1" };
    const { category, updatePresetSubjects } = setup([initial]);
    const subjects = field(category, "support_staff");
    if (subjects.kind !== "mentionable-select") {
      throw new Error("Expected mentionable select");
    }
    const otherContext = { ...context, settingsSessionId: "message-2" };
    await subjects.load(context, "render");
    await subjects.load(otherContext, "render");

    await subjects.mutate(mentionables, context);
    await subjects.mutate(
      [
        mentionables[1]!,
        {
          kind: "user",
          id: "user-2",
          user: { id: "user-2", username: "sam", globalName: "Sam" },
        },
      ],
      otherContext,
    );

    expect(updatePresetSubjects).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        add: [{ subjectType: "user", subjectId: "user-1" }],
        remove: [],
      }),
    );
    expect(updatePresetSubjects).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        add: [{ subjectType: "user", subjectId: "user-2" }],
        remove: [],
      }),
    );
  });

  it("refreshes an expired selector instead of silently skipping removals", async () => {
    const { category, updatePresetSubjects } = setup([
      { subjectType: "role", subjectId: "role-1" },
    ]);
    const subjects = field(category, "support_staff");
    if (subjects.kind !== "mentionable-select") {
      throw new Error("Expected mentionable select");
    }

    await expect(subjects.mutate([], context)).resolves.toMatchObject({
      status: "invalid",
      issues: [
        expect.objectContaining({ message: expect.stringContaining("expired") }),
      ],
    });
    expect(updatePresetSubjects).not.toHaveBeenCalled();
  });

  it("expires selector baselines with abandoned settings sessions", async () => {
    const { category, updatePresetSubjects } = setup([
      { subjectType: "role", subjectId: "role-1" },
    ]);
    const subjects = field(category, "support_staff");
    if (subjects.kind !== "mentionable-select") {
      throw new Error("Expected mentionable select");
    }
    await subjects.load(context, "render");
    for (let index = 0; index < 100; index += 1) {
      await subjects.load(
        { ...context, settingsSessionId: `abandoned-${String(index)}` },
        "render",
      );
    }

    await expect(subjects.mutate([], context)).resolves.toMatchObject({
      status: "invalid",
    });
    expect(updatePresetSubjects).not.toHaveBeenCalled();
  });

  it("recovers oversized legacy presets through the same native selector", async () => {
    const initial = Array.from({ length: 26 }, (_, index) => ({
      subjectType: "role" as const,
      subjectId: `123456789012345${String(index).padStart(3, "0")}`,
    }));
    const { category, updatePresetSubjects } = setup(initial);
    const renderer = createSettingsRenderer({
      title: "Prod settings",
      categories: [category],
    });

    await expect(
      renderer.render({ categoryId: "permissions" }, context),
    ).resolves.toBeDefined();
    const subjects = field(category, "support_staff");
    if (subjects.kind !== "mentionable-select") {
      throw new Error("Expected mentionable select");
    }
    expect((await subjects.load(context, "mutation")).defaults).toHaveLength(
      25,
    );
    await subjects.mutate([], context);
    expect(updatePresetSubjects).toHaveBeenCalledWith(
      expect.objectContaining({ add: [], remove: initial.slice(0, 25) }),
    );
  });
});
