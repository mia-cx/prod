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
  const addPresetSubjects = vi.fn(
    async (input: {
      preset: PermissionPreset;
      subjects: readonly PermissionSubject[];
    }) => {
      const current = subjects.get(input.preset) ?? [];
      const merged = new Map(
        current.map((subject) => [
          `${subject.subjectType}:${subject.subjectId}`,
          subject,
        ]),
      );
      for (const subject of input.subjects) {
        merged.set(`${subject.subjectType}:${subject.subjectId}`, subject);
      }
      subjects.set(input.preset, [...merged.values()]);
    },
  );
  const removePresetSubjects = vi.fn(
    async (input: {
      preset: PermissionPreset;
      subjects: readonly PermissionSubject[];
    }) => {
      const removed = new Set(
        input.subjects.map(
          (subject) => `${subject.subjectType}:${subject.subjectId}`,
        ),
      );
      subjects.set(
        input.preset,
        (subjects.get(input.preset) ?? []).filter(
          (subject) =>
            !removed.has(`${subject.subjectType}:${subject.subjectId}`),
        ),
      );
    },
  );
  const clearPreset = vi.fn(async (input: { preset: PermissionPreset }) => {
    subjects.set(input.preset, []);
  });
  const applyCustomRules = vi.fn(async () => undefined);
  const removeRule = vi.fn(async () => undefined);
  const service: PermissionAdministrationService = {
    listPresetSubjects: async (_guildId, preset) => subjects.get(preset) ?? [],
    setPresetSubjects,
    addPresetSubjects,
    removePresetSubjects,
    clearPreset,
    applyCustomRules,
    listRules: async ({ offset = 0, limit = 10 }) => ({
      items: rules.slice(offset, offset + limit),
      total: rules.length,
      offset,
      limit,
    }),
    removeRule,
  };
  let time = 1_000;
  const category = createPermissionSettingsCategory<Context>({
    service,
    authorize: () => true,
    requireAuthorization: async () => undefined,
    now: () => time,
  });
  return {
    category,
    setPresetSubjects,
    addPresetSubjects,
    removePresetSubjects,
    clearPreset,
    applyCustomRules,
    removeRule,
    advanceTime: (milliseconds: number) => {
      time += milliseconds;
    },
  };
};

const field = (
  category: ReturnType<typeof setup>["category"],
  subcategoryId: string,
  fieldId: string,
): SettingsField<Context> => {
  const found = category.subcategories
    .find(({ id }) => id === subcategoryId)
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
  it("adds users and roles through one preset mentionable control", async () => {
    const { category, addPresetSubjects } = setup();
    const add = field(category, "support_staff", "add");
    if (add.kind !== "mentionable-select")
      throw new Error("Expected mentionable select");

    await add.mutate(mentionables, context);

    expect(addPresetSubjects).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        preset: "support_staff",
        subjects: [
          { subjectType: "user", subjectId: "user-1" },
          { subjectType: "role", subjectId: "role-1" },
        ],
        actorUserId: "admin-1",
      }),
    );
  });

  it("renders explicit subject types with stateful preset pagination", async () => {
    const subjects = Array.from({ length: 80 }, (_, index) => ({
      subjectType: index % 2 === 0 ? ("user" as const) : ("role" as const),
      subjectId: `subject-${String(index)}`,
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
    expect(content).toContain("User · subject-0");
    expect(content).toContain("Role · subject-1");
  });

  it("can reach and remove a preset subject beyond the first 500", async () => {
    const subjects = Array.from({ length: 520 }, (_, index) => ({
      subjectType: "role" as const,
      subjectId: `subject-${String(index)}`,
    }));
    const { category, removePresetSubjects } = setup(subjects);
    const next = field(category, "support_staff", "next");
    const remove = field(category, "support_staff", "remove");
    if (next.kind !== "button" || remove.kind !== "string-select") {
      throw new Error("Expected preset pagination controls");
    }
    for (let page = 0; page < 20; page += 1) await next.mutate(context);

    expect(await remove.load(context)).toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({ value: "role:subject-500" }),
      ]),
    });
    await remove.mutate(["role:subject-500"], context);
    expect(removePresetSubjects).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "support_staff",
        subjects: [{ subjectType: "role", subjectId: "subject-500" }],
      }),
    );
  });

  it("requires a second clear click within the confirmation window", async () => {
    const { category, clearPreset, advanceTime } = setup([
      { subjectType: "role", subjectId: "role-1" },
    ]);
    const clear = field(category, "support_staff", "clear");
    if (clear.kind !== "button") throw new Error("Expected clear button");

    await clear.mutate(context);
    expect(clearPreset).not.toHaveBeenCalled();
    expect(await clear.load(context)).toMatchObject({
      buttonLabel: "Confirm clear",
    });
    await clear.mutate(context);
    expect(clearPreset).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        preset: "support_staff",
        actorUserId: "admin-1",
      }),
    );

    advanceTime(2 * 60 * 1_000 + 1);
    await clear.mutate(context);
    expect(clearPreset).toHaveBeenCalledOnce();
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

  it("exposes no category- or channel-context administration control", () => {
    const { category } = setup();
    const serialized = JSON.stringify(category);
    expect(serialized).not.toContain("categoryId");
    expect(serialized).not.toContain("channelId");
    expect(category.subcategories.map(({ id }) => id)).toEqual([
      "support_staff",
      "assignment_manager",
      "configurator",
      "advanced",
      "rules",
    ]);
  });
});
