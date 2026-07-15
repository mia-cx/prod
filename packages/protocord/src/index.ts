export type {
  Action,
  ActionAvailability,
  ActionAvailabilityInput,
  ActionInput,
  ActionInvocation,
  ActionRequester,
  AuthorizationDecision,
  Authorize,
  Awaitable,
  DispatchOutcome,
  DispatchRequest,
  DispatchResult,
  InvocationDetails,
  JsonSchema,
  RegisteredTrigger,
  TriggerDefinition,
  TriggerProvider,
} from "./contracts.js";
export { createActionRegistry } from "./registry.js";
export type { ActionRegistry } from "./registry.js";
export {
  createDiscordInteractionProviders,
  createDiscordMessageContextProvider,
  createDiscordSlashCommandProvider,
  createDiscordUserContextProvider,
  discordMessageContextProviderId,
  discordSlashCommandProviderId,
  discordUserContextProviderId,
  dispatchDiscordAutocomplete,
  dispatchDiscordInteraction,
  getDiscordCommandRegistration,
  handleDiscordInteraction,
  messageContextMenu,
  registerDiscordCommands,
  slashCommand,
  userContextMenu,
} from "./discord-interactions.js";
export type {
  DiscordAcknowledgement,
  DiscordAutocomplete,
  DiscordCommandRegistrationTarget,
  DiscordCommandRegistrationLogger,
  DiscordInteractionHandleResult,
  MessageContextMenuTrigger,
  SlashCommandTrigger,
  UserContextMenuTrigger,
} from "./discord-interactions.js";
export {
  TEXT_COMMAND_PROVIDER_ID,
  createTextCommandProvider,
  dispatchTextCommand,
  textCommandTrigger,
} from "./text-commands.js";
export type {
  DispatchTextCommandRequest,
  PresentTextCommand,
  TextCommandDispatchResult,
  TextCommandMessage,
  TextCommandProvider,
  TextCommandProviderOptions,
  TextCommandTrigger,
} from "./text-commands.js";

export type ProtocordPackageBoundary = Readonly<{
  name: "protocord";
  concreteActionCount: 0;
}>;

export const protocordBoundary: ProtocordPackageBoundary = Object.freeze({
  name: "protocord",
  concreteActionCount: 0,
});
