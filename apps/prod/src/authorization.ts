import {
  createAuthorizationService,
  InvalidAuthorizationInputError,
  validateAuthorizationContext,
  type AuthorizationCheck,
  type AuthorizationContext,
  type AuthorizationResourceValidator,
  type AuthorizationService,
  type PermissionRule,
  type PermissionRuleStore,
  type RuleObject,
} from "@protocord/permissions";

export class UnsupportedProdAuthorizationContextError extends Error {
  override readonly name = "UnsupportedProdAuthorizationContextError";
}

export const assertProdAuthorizationContext = (
  context: AuthorizationContext,
): void => {
  validateAuthorizationContext(context);
  if (context.categoryId !== undefined || context.channelId !== undefined) {
    throw new UnsupportedProdAuthorizationContextError(
      "Prod MVP supports guild-level authorization contexts only",
    );
  }
};

export const createProdAuthorizationContext = (
  guildId: string,
): AuthorizationContext => {
  if (guildId.length === 0) {
    throw new InvalidAuthorizationInputError("guildId must not be empty");
  }
  return Object.freeze({ guildId });
};

export const createProdPermissionRuleStore = (
  store: PermissionRuleStore,
): PermissionRuleStore =>
  Object.freeze({
    upsert: async (rule: PermissionRule): Promise<void> => {
      assertProdAuthorizationContext(rule.context);
      await store.upsert(rule);
    },
    remove: (ruleId: string, actorUserId?: string): Promise<void> =>
      store.remove(ruleId, actorUserId),
    listForContext: async (
      context: AuthorizationContext,
    ): Promise<readonly PermissionRule[]> => {
      assertProdAuthorizationContext(context);
      return store.listForContext(context);
    },
    listForObject: async (input: {
      context: AuthorizationContext;
      object: RuleObject;
    }): Promise<readonly PermissionRule[]> => {
      assertProdAuthorizationContext(input.context);
      return store.listForObject(input);
    },
  });

export type CreateProdAuthorizationServiceOptions = Readonly<{
  store: PermissionRuleStore;
  validateResource: AuthorizationResourceValidator;
}>;

export const createProdAuthorizationService = (
  options: CreateProdAuthorizationServiceOptions,
): AuthorizationService => {
  const service = createAuthorizationService({
    store: createProdPermissionRuleStore(options.store),
    validateResource: options.validateResource,
  });
  return Object.freeze({
    check: async (input: AuthorizationCheck) => {
      assertProdAuthorizationContext(input.context);
      return await service.check(input);
    },
    require: async (input: AuthorizationCheck) => {
      assertProdAuthorizationContext(input.context);
      await service.require(input);
    },
  });
};
