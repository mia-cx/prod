import { afterEach, describe, expect, it } from "vitest";
import { createSqlitePermissionRuleStore } from "@protocord/permissions";

import { openDatabase, type DatabaseConnection } from "../src/database.js";
import { createPermissionContributionStore } from "../src/permission-contribution-store.js";
import type {
  PermissionRuleIdentity,
  PermissionRuleOrigin,
} from "../src/permission-rule-provenance.js";
import { applyMigrations } from "../src/migrations.js";

const connections: DatabaseConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

const identity = (verb: PermissionRuleIdentity["verb"] = "close") => ({
  guildId: "guild-1",
  subject: { subjectType: "role" as const, subjectId: "role-1" },
  object: { objectType: "ticket" as const, objectId: "*" },
  verb,
});

const custom: PermissionRuleOrigin = {
  sourceType: "custom",
  sourceId: "custom",
};
const preset: PermissionRuleOrigin = {
  sourceType: "preset",
  sourceId: "support_staff",
};

describe("permission contribution persistence", () => {
  it("audits an origin removal even when the effective rule is unchanged", async () => {
    const connection = openDatabase(":memory:");
    connections.push(connection);
    await applyMigrations(connection.database);
    let nextId = 0;
    const store = createPermissionContributionStore(connection.database, {
      createId: () => `id-${String(++nextId)}`,
      now: () => "2026-07-17T10:00:00.000Z",
    });

    await store.apply({
      actorUserId: "admin-1",
      changes: [
        { kind: "put", identity: identity(), origin: custom, permit: "allow" },
        { kind: "put", identity: identity(), origin: preset, permit: "allow" },
      ],
    });
    await store.apply({
      actorUserId: "admin-2",
      changes: [{ kind: "remove", identity: identity(), origin: preset }],
    });

    await expect(store.list(identity())).resolves.toEqual([
      { ...custom, permit: "allow" },
    ]);
    expect((await store.listEvents()).at(-1)).toMatchObject({
      identity: identity(),
      origin: preset,
      eventType: "removed",
      actorUserId: "admin-2",
      beforePermit: "allow",
      afterPermit: null,
    });
  });

  it("rolls back contributions, effective rules, and audits together", async () => {
    const connection = openDatabase(":memory:");
    connections.push(connection);
    await applyMigrations(connection.database);
    const store = createPermissionContributionStore(connection.database, {
      createId: () => "duplicate-id",
    });
    const rules = createSqlitePermissionRuleStore(connection.database);

    await expect(
      store.apply({
        actorUserId: "admin-1",
        changes: [
          {
            kind: "put",
            identity: identity("close"),
            origin: custom,
            permit: "allow",
          },
          {
            kind: "put",
            identity: identity("reopen"),
            origin: custom,
            permit: "allow",
          },
        ],
      }),
    ).rejects.toThrow();

    await expect(store.list(identity("close"))).resolves.toEqual([]);
    await expect(store.list(identity("reopen"))).resolves.toEqual([]);
    await expect(store.listEvents()).resolves.toEqual([]);
    await expect(rules.listForContext({ guildId: "guild-1" })).resolves.toEqual(
      [],
    );
    await expect(rules.listEvents()).resolves.toEqual([]);
  });
});
