import { modelSettingsSchemaOwner } from "@mia-cx/protocord-model-settings/schema";
import { permissionsSchemaOwner } from "@protocord/permissions/schema";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export * from "@mia-cx/protocord-model-settings/schema";
export * from "@protocord/permissions/schema";

export const prodSchemaOwner = "@prod/app" as const;

export const guildSettings = sqliteTable(
  "guild_settings",
  {
    guildId: text("guild_id").notNull(),
    key: text({
      enum: [
        "initialized",
        "hub_channel_id",
        "hub_information_message_id",
        "hub_permission_ownership",
        "hub_transition",
        "assistant_identity",
        "tone",
      ],
    }).notNull(),
    value: text().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.key] }),
    index("guild_settings_guild").on(table.guildId),
  ],
);

export const tickets = sqliteTable(
  "tickets",
  {
    id: text().primaryKey(),
    guildId: text("guild_id").notNull(),
    hubChannelId: text("hub_channel_id").notNull(),
    reporterUserId: text("reporter_user_id").notNull(),
    originatingAlias: text("originating_alias", {
      enum: ["issue", "report", "debugshare"],
    }).notNull(),
    status: text({
      enum: ["provisioning", "open", "closed", "failed"],
    }).notNull(),
    triageStatus: text("triage_status", {
      enum: ["collecting", "ready", "paused"],
    }).notNull(),
    summary: text(),
    threadId: text("thread_id"),
    openingMessageId: text("opening_message_id"),
    failureReason: text("failure_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("tickets_status").on(table.status),
    index("tickets_reporter_active").on(
      table.guildId,
      table.reporterUserId,
      table.status,
    ),
    uniqueIndex("tickets_thread").on(table.threadId),
  ],
);

export const ticketEvents = sqliteTable(
  "ticket_events",
  {
    sequence: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull().unique(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id),
    guildId: text("guild_id").notNull(),
    eventType: text("event_type", {
      enum: [
        "provisioning_started",
        "reporter_access_granted",
        "thread_created",
        "reporter_added",
        "instructions_posted",
        "opened",
        "provisioning_failed",
        "compensation_completed",
        "compensation_failed",
        "recovery_started",
      ],
    }).notNull(),
    detailsJson: text("details_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("ticket_events_ticket_sequence").on(table.ticketId, table.sequence),
    index("ticket_events_guild").on(table.guildId),
  ],
);

export const reporterHubAccess = sqliteTable(
  "reporter_hub_access",
  {
    guildId: text("guild_id").notNull(),
    hubChannelId: text("hub_channel_id").notNull(),
    reporterUserId: text("reporter_user_id").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.guildId, table.hubChannelId, table.reporterUserId],
    }),
    index("reporter_hub_access_guild").on(table.guildId),
  ],
);

export const schemaContributors = Object.freeze([
  permissionsSchemaOwner,
  modelSettingsSchemaOwner,
  prodSchemaOwner,
]);
