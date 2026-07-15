import { discordSettingsBoundary } from "@prod/discord-settings";

export const modelConfigBoundary = Object.freeze({
  name: "@prod/model-config" as const,
  settingsRuntime: discordSettingsBoundary.name,
});

export const modelConfigMigrationManifest = Object.freeze({
  owner: "model-config" as const,
  migrations: Object.freeze([]),
});
