export type {
  AuthorizationCheck,
  AuthorizationContext,
  AuthorizationDecision,
  AuthorizationObject,
  AuthorizationResourceValidator,
  AuthorizationService,
  AuthorizationSubject,
  PermissionRule,
  PermissionRuleActor,
  PermissionRuleInput,
  PermissionRuleStore,
  PermissionVerb,
  RuleObject,
  RuleSubject,
  RemovePermissionRuleInput,
  ServiceAuthorizationSubject,
  UserAuthorizationSubject,
  UpsertPermissionRuleInput,
} from "./contracts.js";
export {
  AuthorizationDeniedError,
  AuthorizationResourceMismatchError,
  createAuthorizationService,
  type CreateAuthorizationServiceOptions,
} from "./evaluator.js";
export {
  authorizationContextLayers,
  authorizationContextsEqual,
  InvalidAuthorizationInputError,
  validateAuthorizationCheck,
  validateAuthorizationContext,
  validateAuthorizationObject,
  validateAuthorizationSubject,
  validatePermissionRule,
  validatePermissionRuleActor,
  validatePermissionRuleInput,
  validatePermissionVerb,
  validateRuleObject,
  validateRuleSubject,
} from "./validation.js";
export {
  createSqlitePermissionRuleStore,
  type CreateSqlitePermissionRuleStoreOptions,
  PermissionRuleConflictError,
  type PermissionRuleEvent,
  type SqlitePermissionRuleStore,
} from "./sqlite-store.js";
export {
  createDiscordAuthorizationContext,
  createDiscordUserSubject,
  InvalidDiscordAuthorizationContextError,
  type DiscordAuthorizationLocation,
  type DiscordCategoryLike,
  type DiscordChannelLike,
  type DiscordGuildLike,
  type DiscordMemberLike,
} from "./discord-adapters.js";

export const permissionsBoundary = Object.freeze({
  name: "@protocord/permissions" as const,
});
