import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { openDatabase } from "../src/database.js";
import { permissionRules } from "../src/schema.js";
import {
  applyMigrations,
  migrationsFolder,
  type MigrationRunner,
} from "../src/migrations.js";

describe("application-owned migration history", () => {
  it("applies the checked-in Drizzle history as one application-owned stream", async () => {
    const connection = openDatabase(":memory:");
    const onHistoryApplied = vi.fn();

    try {
      await applyMigrations(connection.database, undefined, onHistoryApplied);

      const tables = connection.database
        .all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        )
        .map((table) => table.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "protocord_permission_rule_events",
          "protocord_permission_rules",
          "guild_settings",
          "guild_label_taxonomies",
          "labels",
          "permission_rule_origins",
          "reporter_hub_access",
          "ticket_events",
          "ticket_labels",
          "tickets",
        ]),
      );
      const duplicateRule = {
        id: "rule-1",
        guildId: "guild-1",
        categoryId: null,
        channelId: null,
        subjectType: "role",
        subjectId: "role-1",
        objectType: "ticket",
        objectId: "*",
        verb: "close",
        permit: "allow",
        createdByUserId: "admin-1",
        createdAt: "2026-07-16T10:00:00.000Z",
        updatedAt: "2026-07-16T10:00:00.000Z",
      } as const;
      await connection.database.insert(permissionRules).values(duplicateRule);
      await expect(
        connection.database.insert(permissionRules).values({
          ...duplicateRule,
          id: "rule-2",
        }),
      ).rejects.toThrow(/UNIQUE constraint failed/);
    } finally {
      connection.close();
    }

    expect(migrationsFolder).toMatch(/apps\/prod\/drizzle$/);
    expect(onHistoryApplied).toHaveBeenCalledOnce();
    expect(onHistoryApplied).toHaveBeenCalledWith("prod");
  });

  it("passes only the application's migration folder to the runner", async () => {
    const connection = openDatabase(":memory:");
    const runMigrations: MigrationRunner = vi.fn();

    try {
      await applyMigrations(connection.database, runMigrations);
    } finally {
      connection.close();
    }

    expect(runMigrations).toHaveBeenCalledOnce();
    expect(runMigrations).toHaveBeenCalledWith(connection.database, {
      migrationsFolder,
    });
  });
});
