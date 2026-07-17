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
  const applyCustomRules = vi.fn(async () => undefined);
  const removeRule = vi.fn(async () => undefined);
  const service: PermissionAdministrationService = {
    listPresetSubjects: async (_guildId, preset) => subjects.get(preset) ?? [],
    setPresetSubjects,
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
  it("edits users and roles through one preset mentionable control", async () => {
    const { category, setPresetSubjects } = setup([
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

    expect(setPresetSubjects).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        preset: "support_staff",
        subjects: [{ subjectType: "user", subjectId: "user-1" }],
        actorUserId: "admin-1",
      }),
    );
  });

  it("renders explicit subject types in the native preset selector", async () => {
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
    expect(content).toContain("User · 123456789012345670");
    expect(content).toContain("Role · 123456789012345671");
  });

  it("clears a preset by removing every mentionable selection", async () => {
    const { category, setPresetSubjects } = setup([
      { subjectType: "role", subjectId: "role-1" },
    ]);
    const subjects = field(category, "support_staff", "subjects");
    if (subjects.kind !== "mentionable-select") {
      throw new Error("Expected mentionable select");
    }

    await subjects.mutate([], context);
    expect(setPresetSubjects).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        preset: "support_staff",
        subjects: [],
        actorUserId: "admin-1",
      }),
    );
    expect(
      category.subcategories
        .find(({ id }) => id === "support_staff")
        ?.fields.map(({ id }) => id),
    ).toEqual(["current", "subjects"]);
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
