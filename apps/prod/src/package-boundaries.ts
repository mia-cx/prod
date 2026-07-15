import { modelSettingsBoundary } from "@mia-cx/protocord-model-settings";
import { protocordAiBoundary } from "@protocord/ai";
import { permissionsBoundary } from "@protocord/permissions";
import { settingsBoundary } from "@protocord/settings";
import { protocordBoundary } from "protocord";

export const packageBoundaries = Object.freeze([
  permissionsBoundary.name,
  protocordBoundary.name,
  protocordAiBoundary.name,
  settingsBoundary.name,
  modelSettingsBoundary.name,
]);
