import { protocordAiBoundary } from "@protocord/ai";
import { modelConfigBoundary } from "@protocord/model-config";
import { permissionsBoundary } from "@protocord/permissions";
import { settingsBoundary } from "@protocord/settings";
import { protocordBoundary } from "protocord";

export const packageBoundaries = Object.freeze([
  permissionsBoundary.name,
  protocordBoundary.name,
  protocordAiBoundary.name,
  settingsBoundary.name,
  modelConfigBoundary.name,
]);
