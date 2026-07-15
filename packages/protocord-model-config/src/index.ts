import { settingsBoundary } from "@protocord/settings";

export const modelConfigBoundary = Object.freeze({
  name: "@protocord/model-config" as const,
  settingsRuntime: settingsBoundary.name,
});

export const modelConfigMigrationManifest = Object.freeze({
  owner: "model-config" as const,
  migrations: Object.freeze([]),
});
