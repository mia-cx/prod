import { discordActionsBoundary } from "@prod/discord-actions";

export const discordActionsAiBoundary = Object.freeze({
  name: "@prod/discord-actions-ai" as const,
  actionRuntime: discordActionsBoundary.name,
});

