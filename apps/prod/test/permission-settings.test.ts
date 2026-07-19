import { describe, expect, it, vi } from "vitest";
import {
  createSettingsRenderer,
  type SettingsField,
  type SettingsMentionable,
} from "@protocord/settings";
import type { PermissionRule } from "@protocord/permissions";

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

const makeRule = (index: number): PermissionRule => ({
  id: `rule-${String(index).padStart(2, "0")}`,
  context: { guildId: "guild-1" },
  subject: {
    subjectType: index % 2 === 0 ? "user" : "role",
    subjectId: `subject-${String(index).padStart(2, "0")}`,
  },
  object: { objectType: "ticket", objectId: "*" },
  verb: "close",
  permit: "allow",
  createdByUserId: "admin-1",
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
});

const setup = (
  initialSubjects: readonly PermissionSubject[] = [],
  rules: readonly PermissionRule[] = [],
) => {
  const subjects = new Map<PermissionPreset, readonly PermissionSubject[]>([
    ["support_staff", initialSubjects],
    ["assignment_manager", []],
    ["configurator", []],
  ]);
  const setPresetSubjects = vi.fn(
    async (input: {
      preset: PermissionPreset;
      subjects: readonly PermissionSubject[];
    }) => {
      subjects.set(input.preset, input.subjects);
    },
  );
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
  const applyCustomRules = vi.fn(async () => undefined);
  const removeRule = vi.fn(async () => undefined);
  const service: PermissionAdministrationService = {
    listPresetSubjects: async (_guildId, preset) => subjects.get(preset) ?? [],
    setPresetSubjects,
    updatePresetSubjects,
    applyCustomRules,
    listRules: async ({ offset = 0, limit = 10 }) => ({
      items: rules.slice(offset, offset + limit),
      total: rules.length,
      offset,
      limit,
    }),
    removeRule,
  };
  const category = createPermissionSettingsCategory<Context>({
    service,
    authorize: () => true,
    requireAuthorization: async () => undefined,
  });
  return {
    category,
    setPresetSubjects,
    updatePresetSubjects,
    applyCustomRules,
    removeRule,
  };
};

const field = (
  category: ReturnType<typeof setup>["category"],
  subcategoryId: string,
  fieldId: string,
): SettingsField<Context> => {
  const found = category.subcategories
    ?.find(({ id }) => id === subcategoryId)
    ?.fields.find(({ id }) => id === fieldId);
  if (found === undefined)
    throw new Error(`Missing ${subcategoryId}/${fieldId}`);
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
  it("edits users and roles through one preset mentionable control", async () => {
    const { category, updatePresetSubjects } = setup([
      { subjectType: "role", subjectId: "role-1" },
    ]);
    const subjects = field(category, "support_staff", "subjects");
    if (subjects.kind !== "mentionable-select")
      throw new Error("Expected mentionable select");

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
    const subjects = Array.from({ length: 2 }, (_, index) => ({
      subjectType: index % 2 === 0 ? ("user" as const) : ("role" as const),
      subjectId: `12345678901234567${String(index)}`,
    }));
    const { category } = setup(subjects);
    const renderer = createSettingsRenderer({
      title: "Prod settings",
      categories: [category],
    });

    const rendered = await renderer.render(
      {
        categoryId: "permissions",
        subcategoryId: "support_staff",
        page: 0,
      },
      context,
    );

    expect(rendered.location.pageCount).toBe(1);
    const content = JSON.stringify(rendered.components);
    expect(content).toContain(
      '"default_values":[{"id":"123456789012345670","type":"user"},{"id":"123456789012345671","type":"role"}]',
    );
    expect(content).not.toContain("Current subjects");
    expect(content).not.toContain("configured");
  });

  it("clears a preset by removing every mentionable selection", async () => {
    const { category, updatePresetSubjects } = setup([
      { subjectType: "role", subjectId: "role-1" },
    ]);
    const subjects = field(category, "support_staff", "subjects");
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
    expect(
      category.subcategories
        ?.find(({ id }) => id === "support_staff")
        ?.fields.map(({ id }) => id),
    ).toEqual(["subjects"]);
  });

  it("preserves unseen additions from another settings message", async () => {
    const initial = { subjectType: "role" as const, subjectId: "role-1" };
    const { category, updatePresetSubjects } = setup([initial]);
    const subjects = field(category, "support_staff", "subjects");
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
    const subjects = field(category, "support_staff", "subjects");
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
    const subjects = field(category, "support_staff", "subjects");
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
      renderer.render(
        {
          categoryId: "permissions",
          subcategoryId: "support_staff",
          page: 0,
        },
        context,
      ),
    ).resolves.toBeDefined();
    const subjects = field(category, "support_staff", "subjects");
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

  it("previews a staged exact-ticket deny before confirmation", async () => {
    const { category, applyCustomRules } = setup();
    const subjects = field(category, "advanced", "subjects");
    const scope = field(category, "advanced", "scope");
    const ticket = field(category, "advanced", "ticket-id");
    const verbs = field(category, "advanced", "verbs");
    const permit = field(category, "advanced", "permit");
    const preview = field(category, "advanced", "preview");
    const confirm = field(category, "advanced", "confirm");
    if (
      subjects.kind !== "mentionable-select" ||
      scope.kind !== "string-select" ||
      ticket.kind !== "modal" ||
      verbs.kind !== "string-select" ||
      permit.kind !== "string-select" ||
      preview.kind !== "display" ||
      confirm.kind !== "button"
    ) {
      throw new Error("Unexpected advanced field types");
    }

    await subjects.mutate(mentionables, context);
    await scope.mutate(["ticket"], context);
    await ticket.mutate({ ticket: "ticket-42" }, context);
    await verbs.mutate(["label", "close"], context);
    await permit.mutate(["deny"], context);

    expect(await preview.load(context)).toMatchObject({
      value: expect.stringContaining("Object: ticket/ticket-42"),
    });
    expect((await preview.load(context)).value).toContain("Permit: DENY");
    expect((await confirm.load(context)).disabled).toBe(false);
    await confirm.mutate(context);
    expect(applyCustomRules).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        subjects: [
          { subjectType: "user", subjectId: "user-1" },
          { subjectType: "role", subjectId: "role-1" },
        ],
        object: { objectType: "ticket", objectId: "ticket-42" },
        verbs: ["label", "close"],
        permit: "deny",
        actorUserId: "admin-1",
      }),
    );
  });

  it("isolates staged rules between settings messages", async () => {
    const { category, applyCustomRules } = setup();
    const subjects = field(category, "advanced", "subjects");
    const verbs = field(category, "advanced", "verbs");
    const permit = field(category, "advanced", "permit");
    const confirm = field(category, "advanced", "confirm");
    if (
      subjects.kind !== "mentionable-select" ||
      verbs.kind !== "string-select" ||
      permit.kind !== "string-select" ||
      confirm.kind !== "button"
    ) {
      throw new Error("Unexpected advanced field types");
    }
    const otherMessage = { ...context, settingsSessionId: "message-2" };
    await subjects.mutate([mentionables[0]!], context);
    await verbs.mutate(["close"], context);
    await subjects.mutate([mentionables[1]!], otherMessage);
    await verbs.mutate(["reopen"], otherMessage);
    await permit.mutate(["deny"], otherMessage);

    await confirm.mutate(context);
    expect(applyCustomRules).toHaveBeenCalledWith(
      expect.objectContaining({
        subjects: [{ subjectType: "user", subjectId: "user-1" }],
        verbs: ["close"],
        permit: "allow",
      }),
    );
  });

  it("evicts abandoned settings-session state at a fixed bound", async () => {
    const { category, applyCustomRules } = setup();
    const subjects = field(category, "advanced", "subjects");
    const verbs = field(category, "advanced", "verbs");
    const confirm = field(category, "advanced", "confirm");
    if (
      subjects.kind !== "mentionable-select" ||
      verbs.kind !== "string-select" ||
      confirm.kind !== "button"
    ) {
      throw new Error("Unexpected advanced field types");
    }
    await subjects.mutate([mentionables[0]!], context);
    await verbs.mutate(["close"], context);
    for (let index = 0; index < 100; index += 1) {
      await subjects.mutate([mentionables[1]!], {
        ...context,
        settingsSessionId: `abandoned-${String(index)}`,
      });
    }

    expect(await confirm.mutate(context)).toMatchObject({ status: "invalid" });
    expect(applyCustomRules).not.toHaveBeenCalled();
  });

  it.each(["*", "  *  "])(
    "rejects wildcard %j as an exact ticket ID",
    async (ticketId) => {
      const { category, applyCustomRules } = setup();
      const subjects = field(category, "advanced", "subjects");
      const scope = field(category, "advanced", "scope");
      const ticket = field(category, "advanced", "ticket-id");
      const verbs = field(category, "advanced", "verbs");
      const confirm = field(category, "advanced", "confirm");
      if (
        subjects.kind !== "mentionable-select" ||
        scope.kind !== "string-select" ||
        ticket.kind !== "modal" ||
        verbs.kind !== "string-select" ||
        confirm.kind !== "button"
      ) {
        throw new Error("Unexpected advanced field types");
      }
      await subjects.mutate(mentionables, context);
      await scope.mutate(["ticket"], context);
      expect(
        await ticket.validate?.({ ticket: ticketId }, context),
      ).not.toEqual([]);
      await ticket.mutate({ ticket: ticketId }, context);
      await verbs.mutate(["close"], context);

      expect((await confirm.load(context)).disabled).toBe(true);
      await confirm.mutate(context);
      expect(applyCustomRules).not.toHaveBeenCalled();
    },
  );

  it("paginates inspection controls and removes one selected rule", async () => {
    const rules = Array.from({ length: 520 }, (_, index) => makeRule(index));
    const { category, removeRule } = setup([], rules);
    const renderer = createSettingsRenderer({
      title: "Prod settings",
      categories: [category],
    });
    const rendered = await renderer.render(
      { categoryId: "permissions", subcategoryId: "rules", page: 0 },
      context,
    );
    expect(rendered.location.pageCount).toBe(1);
    expect(JSON.stringify(rendered.components)).toContain("ALLOW · user");

    const next = field(category, "rules", "rules-next");
    const ruleSelect = field(category, "rules", "rules");
    if (next.kind !== "button" || ruleSelect.kind !== "string-select") {
      throw new Error("Expected rule pagination controls");
    }
    for (let page = 0; page < 20; page += 1) await next.mutate(context);
    expect(await ruleSelect.load(context)).toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({ value: rules[500]!.id }),
      ]),
    });
    await ruleSelect.mutate([rules[500]!.id], context);
    expect(removeRule).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        ruleId: rules[500]!.id,
        actorUserId: "admin-1",
      }),
    );
  });

  it("renders an empty rule inspector without summaries or pagination", async () => {
    const { category } = setup();
    const renderer = createSettingsRenderer({
      title: "Prod settings",
      categories: [category],
    });

    const rendered = await renderer.render(
      { categoryId: "permissions", subcategoryId: "rules", page: 0 },
      context,
    );
    const payload = JSON.stringify(rendered.components);

    expect(payload).toContain("## Rules");
    expect(payload).toContain("Select one active rule to remove.");
    expect(payload).toContain("No rules in this range");
    expect(payload).not.toContain("Active rules");
    expect(payload).not.toContain("Previous page");
    expect(payload).not.toContain("Next page");
    expect(payload).not.toContain("**Current:**");
  });

  it("exposes no category- or channel-context administration control", () => {
    const { category } = setup();
    const serialized = JSON.stringify(category);
    expect(serialized).not.toContain("categoryId");
    expect(serialized).not.toContain("channelId");
    expect(category.subcategories?.map(({ id }) => id)).toEqual([
      "support_staff",
      "assignment_manager",
      "configurator",
      "advanced",
      "rules",
    ]);
  });
});
