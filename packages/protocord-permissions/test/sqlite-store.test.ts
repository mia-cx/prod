import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSqlitePermissionRuleStore,
  type PermissionRule,
  type SqlitePermissionRuleStore,
} from "../src/index.js";

const timestamp = "2026-07-16T10:00:00.000Z";

const fixtureRule = (
  overrides: Partial<PermissionRule> = {},
): PermissionRule => ({
  id: "rule-1",
  context: { guildId: "guild-1" },
  subject: { subjectType: "user", subjectId: "user-1" },
  object: { objectType: "ticket", objectId: "*" },
  verb: "close",
  permit: "allow",
  createdByUserId: "admin-1",
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

describe("SQLite permission rule store", () => {
  let sqlite: Database.Database;
  let store: SqlitePermissionRuleStore;
  let nextId: number;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE protocord_permission_rules (
        id text PRIMARY KEY NOT NULL,
        guild_id text NOT NULL,
        category_id text,
        channel_id text,
        category_scope text GENERATED ALWAYS AS (coalesce(category_id, '')) VIRTUAL NOT NULL,
        channel_scope text GENERATED ALWAYS AS (coalesce(channel_id, '')) VIRTUAL NOT NULL,
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        object_type text NOT NULL,
        object_id text NOT NULL,
        verb text NOT NULL,
        permit text NOT NULL,
        created_by_user_id text NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );
      CREATE UNIQUE INDEX protocord_permission_rules_identity ON protocord_permission_rules (
        guild_id,
        category_scope,
        channel_scope,
        subject_type,
        subject_id,
        object_type,
        object_id,
        verb
      );
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
      );
    `);
    nextId = 0;
    store = createSqlitePermissionRuleStore(drizzle(sqlite), {
      createId: () => `event-${++nextId}`,
      now: () => timestamp,
    });
  });

  afterEach(() => sqlite.close());

  it.each([
    ["user", "user-1"],
    ["role", "role-1"],
    ["service", "prod-ai"],
    ["everyone", "*"],
  ] as const)("round-trips a %s selector", async (subjectType, subjectId) => {
    const rule = fixtureRule({
      id: `rule-${subjectType}`,
      subject:
        subjectType === "everyone"
          ? { subjectType, subjectId }
          : { subjectType, subjectId },
    });

    await store.upsert(rule);

    await expect(store.listForContext(rule.context)).resolves.toEqual([rule]);
  });

  it("keeps null context refinements unique and updates an existing key", async () => {
    await store.upsert(fixtureRule());
    await store.upsert(
      fixtureRule({
        id: "replacement-id",
        permit: "deny",
        createdByUserId: "admin-2",
        updatedAt: "2026-07-16T11:00:00.000Z",
      }),
    );

    const stored = await store.listForContext({ guildId: "guild-1" });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: "rule-1",
      permit: "deny",
      createdByUserId: "admin-1",
    });
    await expect(store.listEvents("rule-1")).resolves.toMatchObject([
      { eventType: "created", before: null, after: { permit: "allow" } },
      {
        eventType: "updated",
        actorUserId: "admin-2",
        before: { permit: "allow" },
        after: { permit: "deny" },
      },
    ]);
  });

  it("separates guild, category, and channel contexts", async () => {
    const guildRule = fixtureRule();
    const categoryRule = fixtureRule({
      id: "rule-category",
      context: { guildId: "guild-1", categoryId: "category-1" },
    });
    const channelRule = fixtureRule({
      id: "rule-channel",
      context: {
        guildId: "guild-1",
        categoryId: "category-1",
        channelId: "channel-1",
      },
    });
    await store.upsert(guildRule);
    await store.upsert(categoryRule);
    await store.upsert(channelRule);

    await expect(store.listForContext(guildRule.context)).resolves.toEqual([
      guildRule,
    ]);
    await expect(
      store.listForContext(categoryRule.context),
    ).resolves.toEqual([categoryRule]);
    await expect(store.listForObject({
      context: channelRule.context,
      object: channelRule.object,
    })).resolves.toEqual([channelRule]);
  });

  it("records an immutable removal snapshot and actor", async () => {
    const rule = fixtureRule();
    await store.upsert(rule);
    await store.remove(rule.id, "admin-2");

    await expect(store.listForContext(rule.context)).resolves.toEqual([]);
    await expect(store.listEvents(rule.id)).resolves.toMatchObject([
      { eventType: "created" },
      {
        eventType: "removed",
        actorUserId: "admin-2",
        before: rule,
        after: null,
      },
    ]);
  });
});
