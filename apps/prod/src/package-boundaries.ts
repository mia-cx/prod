import { authorizationBoundary } from "@prod/authorization";
import { discordActionsBoundary } from "@prod/discord-actions";
import { discordActionsAiBoundary } from "@prod/discord-actions-ai";
import { discordSettingsBoundary } from "@prod/discord-settings";
import { modelConfigBoundary } from "@prod/model-config";

export const packageBoundaries = Object.freeze([
  authorizationBoundary.name,
  discordActionsBoundary.name,
  discordActionsAiBoundary.name,
  discordSettingsBoundary.name,
  modelConfigBoundary.name,
]);

