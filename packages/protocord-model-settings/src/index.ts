import { settingsBoundary } from "@protocord/settings";

export * from "./contracts.js";
export * from "./encryption.js";
export * from "./sqlite-store.js";

export const modelSettingsBoundary = Object.freeze({
  name: "@mia-cx/protocord-model-settings" as const,
  settingsRuntime: settingsBoundary.name,
});
