import { settingsBoundary } from "@protocord/settings";

export const modelSettingsBoundary = Object.freeze({
  name: "@mia-cx/protocord-model-settings" as const,
  settingsRuntime: settingsBoundary.name,
});
