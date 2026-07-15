import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const permissionsSchemaOwner = "@protocord/permissions" as const;

export const permissionRules = sqliteTable(
  "protocord_permission_rules",
  {
    id: text().primaryKey(),
    guildId: text("guild_id").notNull(),
    categoryId: text("category_id"),
    channelId: text("channel_id"),
    subjectType: text("subject_type", {
      enum: ["user", "role", "service", "everyone"],
    }).notNull(),
    subjectId: text("subject_id").notNull(),
    objectType: text("object_type", {
      enum: ["ticket", "queue", "settings", "permissions"],
    }).notNull(),
    objectId: text("object_id").notNull(),
    verb: text({
      enum: [
        "view",
        "view_metadata",
        "claim_self",
        "unclaim_self",
        "assign_other",
        "unassign_other",
        "label",
        "pause_triage",
        "resume_triage",
        "close",
        "reopen",
        "suggest_assignee",
        "complete_triage",
        "manage",
      ],
    }).notNull(),
    permit: text({ enum: ["allow", "deny"] }).notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("protocord_permission_rules_identity").on(
      table.guildId,
      sql`coalesce(${table.categoryId}, '')`,
      sql`coalesce(${table.channelId}, '')`,
      table.subjectType,
      table.subjectId,
      table.objectType,
      table.objectId,
      table.verb,
    ),
    index("protocord_permission_rules_context").on(
      table.guildId,
      table.categoryId,
      table.channelId,
    ),
  ],
);

export const permissionRuleEvents = sqliteTable(
  "protocord_permission_rule_events",
  {
    id: text().primaryKey(),
    guildId: text("guild_id").notNull(),
    categoryId: text("category_id"),
    channelId: text("channel_id"),
    ruleId: text("rule_id").notNull(),
    eventType: text("event_type", {
      enum: ["created", "updated", "removed"],
    }).notNull(),
    actorUserId: text("actor_user_id").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("protocord_permission_rule_events_rule").on(
      table.ruleId,
      table.createdAt,
    ),
    index("protocord_permission_rule_events_context").on(
      table.guildId,
      table.categoryId,
      table.channelId,
    ),
  ],
);
