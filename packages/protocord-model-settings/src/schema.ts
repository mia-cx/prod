import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const modelSettingsSchemaOwner =
  "@mia-cx/protocord-model-settings" as const;

export const modelConfigurations = sqliteTable(
  "mia_cx_model_configurations",
  {
    guildId: text("guild_id").notNull(),
    purpose: text({ enum: ["triage"] }).notNull(),
    provider: text({ enum: ["openrouter"] }).notNull(),
    modelId: text("model_id").notNull(),
    encryptedApiKey: text("encrypted_api_key"),
    apiKeyHint: text("api_key_hint"),
    apiKeyNonce: text("api_key_nonce"),
    apiKeyAuthTag: text("api_key_auth_tag"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.purpose] })],
);
