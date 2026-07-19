import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqlitePermissionRuleStore } from "@protocord/permissions";

import { createProdPermissionRuleStore } from "../src/authorization.js";
import { openDatabase, type DatabaseConnection } from "../src/database.js";
import {
  createPermissionAdministrationService,
  PERMISSION_PRESET_RULES,
} from "../src/permission-administration.js";
import { createPermissionContributionStore } from "../src/permission-contribution-store.js";
import { applyMigrations } from "../src/migrations.js";

const connections: DatabaseConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

const setup = async () => {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  await applyMigrations(connection.database);
  const sqliteRules = createSqlitePermissionRuleStore(connection.database, {
    createId: (() => {
      let next = 0;
      return () => `event-${String(++next)}`;
    })(),
    now: () => "2026-07-17T10:00:00.000Z",
  });
  const rules = createProdPermissionRuleStore(sqliteRules);
  const authorize = vi.fn(async () => undefined);
  let nextContribution = 0;
  const contributions = createPermissionContributionStore(connection.database, {
    createId: () => `contribution-${String(++nextContribution)}`,
    now: () => "2026-07-17T10:00:00.000Z",
  });
  const service = createPermissionAdministrationService({
    rules,
    contributions,
    authorize,
  });
  return { service, rules, sqliteRules, contributions, authorize };
};

const role = { subjectType: "role" as const, subjectId: "role-1" };
const otherRole = { subjectType: "role" as const, subjectId: "role-2" };
const user = { subjectType: "user" as const, subjectId: "user-1" };

describe("permission administration", () => {
  it("initializes every preset once for the supplied subjects", async () => {
    const { service } = await setup();

    await expect(
      service.initializePresetsIfEmpty({
        guildId: "guild-1",
        subjects: [role],
        actorUserId: "bot-1",
      }),
    ).resolves.toBe(true);

    for (const preset of [
      "support_staff",
      "assignment_manager",
      "configurator",
    ] as const) {
      await expect(
        service.listPresetSubjects("guild-1", preset),
      ).resolves.toEqual([role]);
    }
  });

  it("does not initialize a guild again after its configuration is cleared", async () => {
    const { service } = await setup();
    await service.initializePresetsIfEmpty({
      guildId: "guild-1",
      subjects: [role],
      actorUserId: "bot-1",
    });
    await service.setPresetSubjects({
      guildId: "guild-1",
      preset: "support_staff",
      subjects: [],
      actorUserId: "admin-1",
    });

    await expect(
      service.initializePresetsIfEmpty({
        guildId: "guild-1",
        subjects: [otherRole],
        actorUserId: "bot-1",
      }),
    ).resolves.toBe(false);
    await expect(
      service.listPresetSubjects("guild-1", "support_staff"),
    ).resolves.toEqual([]);
  });

  it.each([
    "support_staff" as const,
    "assignment_manager" as const,
    "configurator" as const,
  ])(
    "expands the %s preset into individual audited allow rules",
    async (preset) => {
      const { service, rules, sqliteRules, authorize } = await setup();

      await service.setPresetSubjects({
        guildId: "guild-1",
        preset,
        subjects: [role],
        actorUserId: "admin-1",
      });

      const stored = await rules.listForContext({ guildId: "guild-1" });
      expect(
        stored.map(({ object, verb, permit }) => ({ object, verb, permit })),
      ).toEqual(
        PERMISSION_PRESET_RULES[preset].map(({ object, verb }) => ({
          object,
          verb,
          permit: "allow",
        })),
      );
      expect(await service.listPresetSubjects("guild-1", preset)).toEqual([
        role,
      ]);
      expect(await sqliteRules.listEvents()).toHaveLength(stored.length);
      expect(authorize).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves an independently configured rule when preset membership is removed", async () => {
    const { service, rules } = await setup();
    await service.applyCustomRules({
      guildId: "guild-1",
      subjects: [role],
      scope: "guild",
      object: { objectType: "ticket", objectId: "*" },
      verbs: ["close"],
      permit: "allow",
      actorUserId: "admin-1",
    });
    await service.setPresetSubjects({
      guildId: "guild-1",
      preset: "support_staff",
      subjects: [role],
      actorUserId: "admin-1",
    });

    await service.setPresetSubjects({
      guildId: "guild-1",
      preset: "support_staff",
      subjects: [],
      actorUserId: "admin-1",
    });

    const stored = await rules.listForContext({ guildId: "guild-1" });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      subject: role,
      object: { objectType: "ticket", objectId: "*" },
      verb: "close",
      permit: "allow",
    });
  });

  it("preserves an independently configured deny across preset add and removal", async () => {
    const { service, rules } = await setup();
    await service.applyCustomRules({
      guildId: "guild-1",
      subjects: [role],
      scope: "guild",
      object: { objectType: "ticket", objectId: "*" },
      verbs: ["close"],
      permit: "deny",
      actorUserId: "admin-1",
    });
    await service.setPresetSubjects({
      guildId: "guild-1",
      preset: "support_staff",
      subjects: [role],
      actorUserId: "admin-1",
    });
    expect(
      (await rules.listForContext({ guildId: "guild-1" })).find(
        ({ verb }) => verb === "close",
      )?.permit,
    ).toBe("deny");

    await service.setPresetSubjects({
      guildId: "guild-1",
      preset: "support_staff",
      subjects: [],
      actorUserId: "admin-1",
    });

    expect(await rules.listForContext({ guildId: "guild-1" })).toEqual([
      expect.objectContaining({ verb: "close", permit: "deny" }),
    ]);
  });

  it("merges concurrent selector deltas from separate settings views", async () => {
    const { service } = await setup();
    await service.setPresetSubjects({
      guildId: "guild-1",
      preset: "support_staff",
      subjects: [role],
      actorUserId: "admin-1",
    });

    await Promise.all([
      service.updatePresetSubjects({
        guildId: "guild-1",
        preset: "support_staff",
        add: [user],
        remove: [],
        actorUserId: "admin-1",
      }),
      service.updatePresetSubjects({
        guildId: "guild-1",
        preset: "support_staff",
        add: [otherRole],
        remove: [],
        actorUserId: "admin-2",
      }),
    ]);

    await expect(
      service.listPresetSubjects("guild-1", "support_staff"),
    ).resolves.toEqual([role, otherRole, user]);
  });

  it("serializes full source replacements without producing a union", async () => {
    const { service } = await setup();
    await service.setPresetSubjects({
      guildId: "guild-1",
      preset: "support_staff",
      subjects: [role],
      actorUserId: "admin-1",
    });

    await Promise.all([
      service.setPresetSubjects({
        guildId: "guild-1",
        preset: "support_staff",
        subjects: [role, user],
        actorUserId: "admin-1",
      }),
      service.setPresetSubjects({
        guildId: "guild-1",
        preset: "support_staff",
        subjects: [role, otherRole],
        actorUserId: "admin-2",
      }),
    ]);

    const subjects = await service.listPresetSubjects(
      "guild-1",
      "support_staff",
    );
    expect([
      [role, user],
      [role, otherRole],
    ]).toContainEqual(subjects);
  });

  it("does not present a partial preset expansion as configured membership", async () => {
    const { service } = await setup();
    await service.setPresetSubjects({
      guildId: "guild-1",
      preset: "support_staff",
      subjects: [role],
      actorUserId: "admin-1",
    });
    const closeRule = (
      await service.listRules({ guildId: "guild-1", limit: 100 })
    ).items.find(({ subject, verb }) =>
      subject.subjectType === role.subjectType &&
      subject.subjectId === role.subjectId &&
      verb === "close",
    );
    if (closeRule === undefined) throw new Error("Expected preset close rule");

    await service.removeRule({
      guildId: "guild-1",
      ruleId: closeRule.id,
      actorUserId: "admin-1",
    });

    await expect(
      service.listPresetSubjects("guild-1", "support_staff"),
    ).resolves.toEqual([]);
  });

  it("round-trips guild-wide and exact-ticket custom allow/deny rules", async () => {
    const { service } = await setup();
    await service.applyCustomRules({
      guildId: "guild-1",
      subjects: [user, role],
      scope: "exact-ticket",
      object: { objectType: "ticket", objectId: "ticket-1" },
      verbs: ["label", "close"],
      permit: "deny",
      actorUserId: "admin-1",
    });
    await service.applyCustomRules({
      guildId: "guild-1",
      subjects: [role],
      scope: "guild",
      object: { objectType: "permissions", objectId: "*" },
      verbs: ["manage"],
      permit: "allow",
      actorUserId: "admin-1",
    });

    const page = await service.listRules({ guildId: "guild-1", limit: 2 });
    expect(page).toMatchObject({ total: 5, offset: 0, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(
      (await service.listRules({ guildId: "guild-1", offset: 2, limit: 10 }))
        .items,
    ).toHaveLength(3);
    expect(
      (await service.listRules({ guildId: "guild-1", limit: 10 })).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: user,
          object: { objectType: "ticket", objectId: "ticket-1" },
          verb: "close",
          permit: "deny",
        }),
        expect.objectContaining({
          subject: role,
          object: { objectType: "permissions", objectId: "*" },
          verb: "manage",
          permit: "allow",
        }),
      ]),
    );
  });

  it("authorizes a self-revoking preset clear once before applying the whole batch", async () => {
    const { service, rules } = await setup();
    await service.setPresetSubjects({
      guildId: "guild-1",
      preset: "configurator",
      subjects: [user],
      actorUserId: user.subjectId,
    });
    const recheckAuthorization = vi.fn(async () => {
      if (recheckAuthorization.mock.calls.length > 1) {
        throw new Error("authorization was revoked mid-batch");
      }
    });

    await expect(
      service.setPresetSubjects({
        guildId: "guild-1",
        preset: "configurator",
        subjects: [],
        actorUserId: user.subjectId,
        recheckAuthorization,
      }),
    ).resolves.toBeUndefined();

    expect(recheckAuthorization).toHaveBeenCalledOnce();
    await expect(
      service.listPresetSubjects("guild-1", "configurator"),
    ).resolves.toEqual([]);
    await expect(rules.listForContext({ guildId: "guild-1" })).resolves.toEqual(
      [],
    );
  });

  it("removes one inspected rule with an authorization recheck and audit event", async () => {
    const { service, sqliteRules, authorize } = await setup();
    await service.applyCustomRules({
      guildId: "guild-1",
      subjects: [user],
      scope: "exact-ticket",
      object: { objectType: "ticket", objectId: "ticket-1" },
      verbs: ["close"],
      permit: "deny",
      actorUserId: "admin-1",
    });
    const [rule] = (await service.listRules({ guildId: "guild-1" })).items;
    authorize.mockClear();

    await service.removeRule({
      guildId: "guild-1",
      ruleId: rule!.id,
      actorUserId: "admin-2",
    });

    await expect(
      service.listRules({ guildId: "guild-1" }),
    ).resolves.toMatchObject({ total: 0, items: [] });
    expect(authorize).toHaveBeenCalledOnce();
    expect((await sqliteRules.listEvents()).at(-1)).toMatchObject({
      ruleId: rule!.id,
      eventType: "removed",
      actorUserId: "admin-2",
    });
  });

  it("removes an inspected legacy rule that has no contribution rows", async () => {
    const { service, sqliteRules, authorize } = await setup();
    await sqliteRules.upsert({
      context: { guildId: "guild-1" },
      rule: {
        id: "legacy-rule",
        context: { guildId: "guild-1" },
        subject: user,
        object: { objectType: "ticket", objectId: "ticket-1" },
        verb: "close",
        permit: "deny",
      },
      actor: { actorType: "user", actorId: "legacy-admin" },
    });
    authorize.mockClear();

    await service.removeRule({
      guildId: "guild-1",
      ruleId: "legacy-rule",
      actorUserId: "admin-2",
    });

    await expect(
      service.listRules({ guildId: "guild-1" }),
    ).resolves.toMatchObject({ total: 0, items: [] });
    expect(authorize).toHaveBeenCalledOnce();
    expect((await sqliteRules.listEvents()).at(-1)).toMatchObject({
      ruleId: "legacy-rule",
      eventType: "removed",
      actorUserId: "admin-2",
    });
  });

  it.each([
    { subjectType: "service" as const, subjectId: "prod-ai" },
    { subjectType: "everyone" as const, subjectId: "*" as const },
  ])("removes an inspected legacy $subjectType rule", async (subject) => {
    const { service, sqliteRules, authorize } = await setup();
    await sqliteRules.upsert({
      context: { guildId: "guild-1" },
      rule: {
        id: `legacy-${subject.subjectType}`,
        context: { guildId: "guild-1" },
        subject,
        object: { objectType: "ticket", objectId: "*" },
        verb: "close",
        permit: "deny",
      },
      actor: { actorType: "user", actorId: "legacy-admin" },
    });
    authorize.mockClear();

    await service.removeRule({
      guildId: "guild-1",
      ruleId: `legacy-${subject.subjectType}`,
      actorUserId: "admin-2",
    });

    await expect(
      service.listRules({ guildId: "guild-1" }),
    ).resolves.toMatchObject({ total: 0, items: [] });
    expect(authorize).toHaveBeenCalledOnce();
    expect((await sqliteRules.listEvents()).at(-1)).toMatchObject({
      ruleId: `legacy-${subject.subjectType}`,
      eventType: "removed",
      actorUserId: "admin-2",
    });
  });

  it("rejects invalid object/verb combinations before authorization", async () => {
    const { service, rules, sqliteRules, authorize } = await setup();
    await expect(
      service.applyCustomRules({
        guildId: "guild-1",
        subjects: [user],
        scope: "guild",
        object: { objectType: "queue", objectId: "*" },
        verbs: ["view", "close"],
        permit: "allow",
        actorUserId: "admin-1",
      }),
    ).rejects.toThrow("close is not valid for queue rules");
    expect(authorize).not.toHaveBeenCalled();
    await expect(rules.listForContext({ guildId: "guild-1" })).resolves.toEqual(
      [],
    );
    await expect(sqliteRules.listEvents()).resolves.toEqual([]);
  });

  it("rejects a wildcard at the exact-ticket service boundary", async () => {
    const { service, authorize } = await setup();
    await expect(
      service.applyCustomRules({
        guildId: "guild-1",
        subjects: [user],
        scope: "exact-ticket",
        object: { objectType: "ticket", objectId: "*" },
        verbs: ["close"],
        permit: "allow",
        actorUserId: "admin-1",
      }),
    ).rejects.toThrow("non-wildcard ticket ID");
    expect(authorize).not.toHaveBeenCalled();
  });
});
