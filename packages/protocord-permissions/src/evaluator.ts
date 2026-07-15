import type {
  AuthorizationCheck,
  AuthorizationDecision,
  AuthorizationResourceValidator,
  AuthorizationService,
  AuthorizationSubject,
  PermissionRule,
  PermissionRuleStore,
  RuleSubject,
} from "./contracts.js";
import {
  authorizationContextLayers,
  validateAuthorizationCheck,
} from "./validation.js";

export class AuthorizationResourceMismatchError extends Error {
  override readonly name = "AuthorizationResourceMismatchError";
}

export class AuthorizationDeniedError extends Error {
  override readonly name = "AuthorizationDeniedError";

  constructor(readonly decision: AuthorizationDecision) {
    super("Authorization denied");
  }
}

const selectorsForSubject = (
  subject: AuthorizationSubject,
): readonly (readonly RuleSubject[])[] => {
  const exact: readonly RuleSubject[] = [
    { subjectType: subject.subjectType, subjectId: subject.subjectId },
  ];
  if (subject.subjectType === "service") {
    return [exact];
  }

  const roles: readonly RuleSubject[] = [
    ...new Set(subject.attributes.discordRoleIds),
  ].map((subjectId) => ({ subjectType: "role", subjectId }));
  return roles.length === 0
    ? [exact, [{ subjectType: "everyone", subjectId: "*" }]]
    : [exact, roles, [{ subjectType: "everyone", subjectId: "*" }]];
};

const sameSelector = (rule: PermissionRule, selector: RuleSubject): boolean =>
  rule.subject.subjectType === selector.subjectType &&
  rule.subject.subjectId === selector.subjectId;

const resolveSubjectLayers = (
  rules: readonly PermissionRule[],
  subject: AuthorizationSubject,
): AuthorizationDecision | undefined => {
  for (const selectors of selectorsForSubject(subject)) {
    const matches = rules.filter((rule) =>
      selectors.some((selector) => sameSelector(rule, selector)),
    );
    if (matches.length === 0) {
      continue;
    }

    return {
      allowed: !matches.some((rule) => rule.permit === "deny"),
      reason: "matched_rule",
      matchedRuleIds: matches.map((rule) => rule.id),
    };
  }
  return undefined;
};

export type CreateAuthorizationServiceOptions = Readonly<{
  store: PermissionRuleStore;
  validateResource: AuthorizationResourceValidator;
}>;

export const createAuthorizationService = (
  options: CreateAuthorizationServiceOptions,
): AuthorizationService => {
  const check = async (
    input: AuthorizationCheck,
  ): Promise<AuthorizationDecision> => {
    validateAuthorizationCheck(input);
    if (
      !(await options.validateResource({
        context: input.context,
        object: input.object,
      }))
    ) {
      throw new AuthorizationResourceMismatchError(
        "Authorization object does not belong to the supplied context",
      );
    }

    if (input.subject.subjectType === "user") {
      if (input.subject.attributes.isGuildOwner) {
        return {
          allowed: true,
          reason: "guild_owner",
          matchedRuleIds: [],
        };
      }
      if (input.subject.attributes.isAdministrator) {
        return {
          allowed: true,
          reason: "administrator",
          matchedRuleIds: [],
        };
      }
    }

    for (const context of authorizationContextLayers(input.context)) {
      const contextRules = (await options.store.listForContext(context)).filter(
        (rule) =>
          rule.verb === input.verb &&
          rule.object.objectType === input.object.objectType,
      );
      const objectIds =
        input.object.objectId === "*"
          ? ["*"]
          : [input.object.objectId, "*"];

      for (const objectId of objectIds) {
        const decision = resolveSubjectLayers(
          contextRules.filter((rule) => rule.object.objectId === objectId),
          input.subject,
        );
        if (decision !== undefined) {
          return decision;
        }
      }
    }

    return {
      allowed: false,
      reason: "default_deny",
      matchedRuleIds: [],
    };
  };

  return Object.freeze({
    check,
    require: async (input: AuthorizationCheck): Promise<void> => {
      const decision = await check(input);
      if (!decision.allowed) {
        throw new AuthorizationDeniedError(decision);
      }
    },
  });
};
