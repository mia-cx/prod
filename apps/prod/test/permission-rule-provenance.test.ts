import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type DatabaseConnection } from "../src/database.js";
import {
  createSqlitePermissionRuleProvenanceStore,
  type PermissionRuleIdentity,
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

describe("permission rule provenance persistence", () => {
  it("stores idempotent, independently removable origins for one rule identity", async () => {
    const connection = openDatabase(":memory:");
    connections.push(connection);
    await applyMigrations(connection.database);
    const store = createSqlitePermissionRuleProvenanceStore(connection.database);
    const preset = { sourceType: "preset" as const, sourceId: "support_staff" };
    const custom = { sourceType: "custom" as const, sourceId: "custom" };

    await store.add(identity(), preset);
    await store.add(identity(), preset);
    await store.add(identity(), custom);
    await expect(store.list(identity())).resolves.toEqual([
      custom,
      preset,
    ]);

    await store.remove(identity(), preset);
    await expect(store.list(identity())).resolves.toEqual([custom]);
  });

  it("lists complete identities by guild and source", async () => {
    const connection = openDatabase(":memory:");
    connections.push(connection);
    await applyMigrations(connection.database);
    const store = createSqlitePermissionRuleProvenanceStore(connection.database);
    const source = {
      sourceType: "preset" as const,
      sourceId: "assignment_manager",
    };
    await store.add(identity("assign_other"), source);
    await store.add(identity("unassign_other"), source);

    await expect(store.listForSource("guild-1", source)).resolves.toEqual([
      identity("assign_other"),
      identity("unassign_other"),
    ]);
    await expect(store.listForSource("guild-2", source)).resolves.toEqual([]);
  });
});
