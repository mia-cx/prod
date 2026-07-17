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
          "reporter_hub_access",
          "ticket_events",
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

  it("upgrades an already-applied legacy event table without losing causal order", async () => {
    const connection = openDatabase(":memory:");

    try {
      connection.database.run(
        sql.raw(`
        CREATE TABLE __drizzle_migrations (
          id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
          hash text NOT NULL,
          created_at numeric
        )
      `),
      );
      connection.database.run(
        sql.raw(`
        INSERT INTO __drizzle_migrations (hash, created_at)
          VALUES ('legacy-0000', 1784195942210)
      `),
      );
      connection.database.run(
        sql.raw(`
        CREATE TABLE protocord_permission_rule_events (
          id text PRIMARY KEY NOT NULL,
          guild_id text NOT NULL,
          category_id text,
          channel_id text,
          rule_id text NOT NULL,
          event_type text NOT NULL,
          actor_user_id text NOT NULL,
          before_json text,
          after_json text,
          created_at text NOT NULL
        )
      `),
      );
      connection.database.run(
        sql.raw(`
        INSERT INTO protocord_permission_rule_events
          (id, guild_id, rule_id, event_type, actor_user_id, created_at)
          VALUES
          ('event-created', 'guild-1', 'rule-1', 'created', 'admin-1', '2026-07-16T11:00:00.000Z'),
          ('event-updated', 'guild-1', 'rule-1', 'updated', 'admin-2', '2026-07-16T10:00:00.000Z')
      `),
      );

      await applyMigrations(connection.database);

      const events = connection.database.all<{
        sequence: number;
        id: string;
      }>(
        sql`SELECT sequence, id FROM protocord_permission_rule_events ORDER BY sequence`,
      );
      expect(events).toEqual([
        { sequence: 1, id: "event-created" },
        { sequence: 2, id: "event-updated" },
      ]);
    } finally {
      connection.close();
    }
  });
});
