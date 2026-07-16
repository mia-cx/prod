import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSqlitePermissionRuleStore,
  PermissionRuleConflictError,
  type PermissionRule,
  type PermissionRuleActor,
  type PermissionRuleInput,
  type SqlitePermissionRuleStore,
} from "../src/index.js";

const timestamp = "2026-07-16T10:00:00.000Z";
const updatedTimestamp = "2026-07-16T11:00:00.000Z";

const fixtureRule = (
  overrides: Partial<PermissionRuleInput> = {},
): PermissionRuleInput => ({
  id: "rule-1",
  context: { guildId: "guild-1" },
  subject: { subjectType: "user", subjectId: "user-1" },
  object: { objectType: "ticket", objectId: "*" },
  verb: "close",
  permit: "allow",
  ...overrides,
});

const actor = (actorId: string): PermissionRuleActor => ({
  actorType: "user",
  actorId,
});

const persistedRule = (
  rule: PermissionRuleInput,
  createdByUserId = "admin-1",
  updatedAt = timestamp,
): PermissionRule => ({
  ...rule,
  createdByUserId,
  createdAt: timestamp,
  updatedAt,
});

describe("SQLite permission rule store", () => {
  let sqlite: Database.Database;
  let store: SqlitePermissionRuleStore;
  let nextId: number;
  let currentTimestamp: string;

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
        updated_at text NOT NULL,
        active integer DEFAULT 1 NOT NULL
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
        sequence integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        id text NOT NULL,
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
      CREATE UNIQUE INDEX protocord_permission_rule_events_id
        ON protocord_permission_rule_events (id);
    `);
    nextId = 0;
    currentTimestamp = timestamp;
    store = createSqlitePermissionRuleStore(drizzle(sqlite), {
      createId: () => `event-${++nextId}`,
      now: () => currentTimestamp,
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

    await store.upsert({
      context: rule.context,
      rule,
      actor: actor("admin-1"),
    });

    await expect(store.listForContext(rule.context)).resolves.toEqual([
      persistedRule(rule),
    ]);
  });

  it("keeps null context refinements unique and updates an existing key", async () => {
    const original = fixtureRule();
    await store.upsert({
      context: original.context,
      rule: original,
      actor: actor("admin-1"),
    });
    currentTimestamp = updatedTimestamp;
    await store.upsert({
      context: original.context,
      rule: fixtureRule({
        id: "replacement-id",
        permit: "deny",
      }),
      actor: actor("admin-2"),
    });

    const stored = await store.listForContext({ guildId: "guild-1" });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: "rule-1",
      permit: "deny",
      createdByUserId: "admin-1",
      createdAt: timestamp,
      updatedAt: updatedTimestamp,
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
    await store.upsert({
      context: guildRule.context,
      rule: guildRule,
      actor: actor("admin-1"),
    });
    await store.upsert({
      context: categoryRule.context,
      rule: categoryRule,
      actor: actor("admin-1"),
    });
    await store.upsert({
      context: channelRule.context,
      rule: channelRule,
      actor: actor("admin-1"),
    });

    await expect(store.listForContext(guildRule.context)).resolves.toEqual([
      persistedRule(guildRule),
    ]);
    await expect(
      store.listForContext(categoryRule.context),
    ).resolves.toEqual([persistedRule(categoryRule)]);
    await expect(store.listForObject({
      context: channelRule.context,
      object: channelRule.object,
    })).resolves.toEqual([persistedRule(channelRule)]);
  });

  it("records an immutable removal snapshot and actor", async () => {
    const rule = fixtureRule();
    await store.upsert({
      context: rule.context,
      rule,
      actor: actor("admin-1"),
    });
    await store.remove({
      ruleId: rule.id,
      context: rule.context,
      actor: actor("admin-2"),
    });

    await expect(store.listForContext(rule.context)).resolves.toEqual([]);
    await expect(store.listEvents(rule.id)).resolves.toMatchObject([
      { eventType: "created" },
      {
        eventType: "removed",
        actorUserId: "admin-2",
        before: persistedRule(rule),
        after: null,
      },
    ]);
  });

  it("orders complete and rule-specific audit histories by mutation sequence", async () => {
    const first = fixtureRule();
    currentTimestamp = updatedTimestamp;
    await store.upsert({
      context: first.context,
      rule: first,
      actor: actor("admin-1"),
    });

    currentTimestamp = timestamp;
    await store.upsert({
      context: first.context,
      rule: { ...first, permit: "deny" },
      actor: actor("admin-2"),
    });

    currentTimestamp = "2026-07-16T09:00:00.000Z";
    const second = fixtureRule({
      id: "rule-2",
      subject: { subjectType: "role", subjectId: "role-2" },
    });
    await store.upsert({
      context: second.context,
      rule: second,
      actor: actor("admin-3"),
    });

    await expect(store.listEvents(first.id)).resolves.toMatchObject([
      { id: "event-1", eventType: "created", createdAt: updatedTimestamp },
      { id: "event-2", eventType: "updated", createdAt: timestamp },
    ]);
    await expect(store.listEvents()).resolves.toMatchObject([
      { id: "event-1", ruleId: first.id },
      { id: "event-2", ruleId: first.id },
      { id: "event-3", ruleId: second.id },
    ]);
  });

  it("rejects an ID collision across identities without changing state or audit", async () => {
    const guildOneRule = fixtureRule();
    const guildTwoRule = fixtureRule({
      context: { guildId: "guild-2" },
      subject: { subjectType: "user", subjectId: "user-2" },
    });
    await store.upsert({
      context: guildOneRule.context,
      rule: guildOneRule,
      actor: actor("admin-1"),
    });

    await expect(
      store.upsert({
        context: guildTwoRule.context,
        rule: guildTwoRule,
        actor: actor("admin-2"),
      }),
    ).rejects.toBeInstanceOf(PermissionRuleConflictError);

    await expect(
      store.listForContext(guildOneRule.context),
    ).resolves.toEqual([persistedRule(guildOneRule)]);
    await expect(store.listForContext(guildTwoRule.context)).resolves.toEqual(
      [],
    );
    await expect(store.listEvents()).resolves.toHaveLength(1);
  });

  it("rejects split ID and identity collisions deterministically", async () => {
    const first = fixtureRule();
    const second = fixtureRule({
      id: "rule-2",
      subject: { subjectType: "role", subjectId: "role-2" },
    });
    await store.upsert({
      context: first.context,
      rule: first,
      actor: actor("admin-1"),
    });
    await store.upsert({
      context: second.context,
      rule: second,
      actor: actor("admin-1"),
    });

    await expect(
      store.upsert({
        context: second.context,
        rule: { ...second, id: first.id, permit: "deny" },
        actor: actor("admin-2"),
      }),
    ).rejects.toBeInstanceOf(PermissionRuleConflictError);

    await expect(store.listForContext(first.context)).resolves.toEqual(
      expect.arrayContaining([persistedRule(first), persistedRule(second)]),
    );
    await expect(store.listEvents()).resolves.toHaveLength(2);
  });

  it("scopes removal atomically to the complete expected context", async () => {
    const rule = fixtureRule();
    await store.upsert({
      context: rule.context,
      rule,
      actor: actor("admin-1"),
    });

    await store.remove({
      ruleId: rule.id,
      context: { guildId: "guild-2" },
      actor: actor("admin-2"),
    });

    await expect(store.listForContext(rule.context)).resolves.toEqual([
      persistedRule(rule),
    ]);
    await expect(store.listEvents(rule.id)).resolves.toHaveLength(1);
  });

  it("rejects untrusted mutation context and empty audit actors without side effects", async () => {
    const rule = fixtureRule();
    await expect(
      store.upsert({
        context: { guildId: "guild-2" },
        rule,
        actor: actor("admin-1"),
      }),
    ).rejects.toThrow("rule context must match the trusted mutation context");

    await store.upsert({
      context: rule.context,
      rule,
      actor: actor("admin-1"),
    });
    await expect(
      store.remove({
        ruleId: rule.id,
        context: rule.context,
        actor: actor(""),
      }),
    ).rejects.toThrow("actor.actorId must not be empty");

    await expect(store.listForContext(rule.context)).resolves.toEqual([
      persistedRule(rule),
    ]);
    await expect(store.listEvents(rule.id)).resolves.toHaveLength(1);
  });

  it("retains removed ID ownership across guilds", async () => {
    const original = fixtureRule();
    await store.upsert({
      context: original.context,
      rule: original,
      actor: actor("admin-1"),
    });
    await store.remove({
      ruleId: original.id,
      context: original.context,
      actor: actor("admin-2"),
    });
    const unrelated = fixtureRule({
      context: { guildId: "guild-2" },
      subject: { subjectType: "role", subjectId: "role-2" },
    });

    await expect(
      store.upsert({
        context: unrelated.context,
        rule: unrelated,
        actor: actor("admin-3"),
      }),
    ).rejects.toBeInstanceOf(PermissionRuleConflictError);

    await expect(store.listForContext(original.context)).resolves.toEqual([]);
    await expect(store.listForContext(unrelated.context)).resolves.toEqual([]);
    await expect(store.listEvents(original.id)).resolves.toHaveLength(2);
  });

  it("restores the same immutable identity with one coherent history", async () => {
    const original = fixtureRule();
    await store.upsert({
      context: original.context,
      rule: original,
      actor: actor("admin-1"),
    });
    await store.remove({
      ruleId: original.id,
      context: original.context,
      actor: actor("admin-2"),
    });
    currentTimestamp = updatedTimestamp;
    const restoration: PermissionRuleInput = {
      ...original,
      id: "replacement-id",
      permit: "deny",
    };
    await store.upsert({
      context: restoration.context,
      rule: restoration,
      actor: actor("admin-3"),
    });

    await expect(store.listForContext(original.context)).resolves.toEqual([
      persistedRule({ ...original, permit: "deny" }, "admin-1", updatedTimestamp),
    ]);
    await expect(store.listEvents(original.id)).resolves.toMatchObject([
      { eventType: "created", actorUserId: "admin-1" },
      { eventType: "removed", actorUserId: "admin-2" },
      {
        eventType: "restored",
        actorUserId: "admin-3",
        before: null,
        after: { id: original.id, permit: "deny" },
      },
    ]);
  });
});
