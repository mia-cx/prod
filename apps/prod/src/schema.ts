import { modelSettingsSchemaOwner } from "@mia-cx/protocord-model-settings/schema";
import { permissionsSchemaOwner } from "@protocord/permissions/schema";
import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export const schemaContributors = Object.freeze([
  permissionsSchemaOwner,
  modelSettingsSchemaOwner,
  prodSchemaOwner,
]);
