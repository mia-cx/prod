import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqlitePermissionRuleStore } from "@protocord/permissions";

import { createProdPermissionRuleStore } from "../src/authorization.js";
import { openDatabase, type DatabaseConnection } from "../src/database.js";
import {
  createPermissionAdministrationService,
  PERMISSION_PRESET_RULES,
} from "../src/permission-administration.js";
import { createSqlitePermissionRuleProvenanceStore } from "../src/permission-rule-provenance.js";
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
  let nextRule = 0;
  const service = createPermissionAdministrationService({
    rules,
    provenance: createSqlitePermissionRuleProvenanceStore(connection.database),
    authorize,
    createId: () => `rule-${String(++nextRule)}`,
  });
  return { service, rules, sqliteRules, authorize };
};

const role = { subjectType: "role" as const, subjectId: "role-1" };
const user = { subjectType: "user" as const, subjectId: "user-1" };

describe("permission administration", () => {
  it.each([
    "support_staff" as const,
    "assignment_manager" as const,
    "configurator" as const,
  ])("expands the %s preset into individual audited allow rules", async (preset) => {
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
    expect(authorize).toHaveBeenCalledTimes(stored.length);
  });

  it("preserves an independently configured rule when preset membership is removed", async () => {
    const { service, rules } = await setup();
    await service.applyCustomRules({
      guildId: "guild-1",
      subjects: [role],
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

  it("round-trips guild-wide and exact-ticket custom allow/deny rules", async () => {
    const { service } = await setup();
    await service.applyCustomRules({
      guildId: "guild-1",
      subjects: [user, role],
      object: { objectType: "ticket", objectId: "ticket-1" },
      verbs: ["label", "close"],
      permit: "deny",
      actorUserId: "admin-1",
    });
    await service.applyCustomRules({
      guildId: "guild-1",
      subjects: [role],
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

  it("removes one inspected rule with an authorization recheck and audit event", async () => {
    const { service, sqliteRules, authorize } = await setup();
    await service.applyCustomRules({
      guildId: "guild-1",
      subjects: [user],
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
    expect(authorize).toHaveBeenCalledTimes(2);
    expect((await sqliteRules.listEvents()).at(-1)).toMatchObject({
      ruleId: rule!.id,
      eventType: "removed",
      actorUserId: "admin-2",
    });
  });

  it("rejects invalid object/verb combinations before authorization", async () => {
    const { service, authorize } = await setup();
    await expect(
      service.applyCustomRules({
        guildId: "guild-1",
        subjects: [user],
        object: { objectType: "queue", objectId: "*" },
        verbs: ["close"],
        permit: "allow",
        actorUserId: "admin-1",
      }),
    ).rejects.toThrow("close is not valid for queue rules");
    expect(authorize).not.toHaveBeenCalled();
  });
});
