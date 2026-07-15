import type {
  AuthorizationCheck,
  AuthorizationContext,
  AuthorizationObject,
  AuthorizationSubject,
  PermissionRule,
  PermissionVerb,
  RuleObject,
  RuleSubject,
} from "./contracts.js";

const objectTypes = new Set(["ticket", "queue", "settings", "permissions"]);
const permissionVerbs = new Set<PermissionVerb>([
  "view",
  "view_metadata",
  "claim_self",
  "unclaim_self",
  "assign_other",
  "unassign_other",
  "label",
  "pause_triage",
  "resume_triage",
  "close",
  "reopen",
  "suggest_assignee",
  "complete_triage",
  "manage",
]);

export class InvalidAuthorizationInputError extends Error {
  override readonly name = "InvalidAuthorizationInputError";
}

const requireIdentifier = (value: string, field: string): void => {
  if (value.length === 0) {
    throw new InvalidAuthorizationInputError(`${field} must not be empty`);
  }
};

export const validateAuthorizationContext = (
  context: AuthorizationContext,
): void => {
  requireIdentifier(context.guildId, "context.guildId");
  if (context.categoryId !== undefined) {
    requireIdentifier(context.categoryId, "context.categoryId");
  }
  if (context.channelId !== undefined) {
    requireIdentifier(context.channelId, "context.channelId");
  }
};

export const validateAuthorizationSubject = (
  subject: AuthorizationSubject,
): void => {
  requireIdentifier(subject.subjectId, "subject.subjectId");
  if (subject.subjectId === "*") {
    throw new InvalidAuthorizationInputError(
      `${subject.subjectType} subjects must use an exact subjectId`,
    );
  }
  if (subject.subjectType === "user") {
    for (const roleId of subject.attributes.discordRoleIds) {
      requireIdentifier(roleId, "subject.attributes.discordRoleIds[]");
    }
  }
};

export const validateRuleSubject = (subject: RuleSubject): void => {
  requireIdentifier(subject.subjectId, "subject.subjectId");
  if (subject.subjectType === "everyone" && subject.subjectId !== "*") {
    throw new InvalidAuthorizationInputError(
      'everyone selectors must use subjectId "*"',
    );
  }
  if (subject.subjectType !== "everyone" && subject.subjectId === "*") {
    throw new InvalidAuthorizationInputError(
      `${subject.subjectType} selectors must use an exact subjectId`,
    );
  }
};

export const validateRuleObject = (object: RuleObject): void => {
  if (!objectTypes.has(object.objectType)) {
    throw new InvalidAuthorizationInputError(
      `unsupported object type: ${object.objectType}`,
    );
  }
  requireIdentifier(object.objectId, "object.objectId");
  if (object.objectType !== "ticket" && object.objectId !== "*") {
    throw new InvalidAuthorizationInputError(
      `${object.objectType} rules must use objectId "*"`,
    );
  }
};

export const validateAuthorizationObject = (
  object: AuthorizationObject,
): void => validateRuleObject(object);

export const validatePermissionVerb = (verb: PermissionVerb): void => {
  if (!permissionVerbs.has(verb)) {
    throw new InvalidAuthorizationInputError(`unsupported verb: ${verb}`);
  }
};

export const validateAuthorizationCheck = (input: AuthorizationCheck): void => {
  validateAuthorizationContext(input.context);
  validateAuthorizationSubject(input.subject);
  validateAuthorizationObject(input.object);
  validatePermissionVerb(input.verb);
};

export const validatePermissionRule = (rule: PermissionRule): void => {
  requireIdentifier(rule.id, "rule.id");
  validateAuthorizationContext(rule.context);
  validateRuleSubject(rule.subject);
  validateRuleObject(rule.object);
  validatePermissionVerb(rule.verb);
  requireIdentifier(rule.createdByUserId, "rule.createdByUserId");
  requireIdentifier(rule.createdAt, "rule.createdAt");
  requireIdentifier(rule.updatedAt, "rule.updatedAt");
  if (rule.permit !== "allow" && rule.permit !== "deny") {
    throw new InvalidAuthorizationInputError(
      `unsupported permit: ${String(rule.permit)}`,
    );
  }
};

export const authorizationContextLayers = (
  context: AuthorizationContext,
): readonly AuthorizationContext[] => {
  validateAuthorizationContext(context);

  const layers: AuthorizationContext[] = [];
  if (context.channelId !== undefined) {
    layers.push(
      context.categoryId === undefined
        ? { guildId: context.guildId, channelId: context.channelId }
        : {
            guildId: context.guildId,
            categoryId: context.categoryId,
            channelId: context.channelId,
          },
    );
  }
  if (context.categoryId !== undefined) {
    layers.push({
      guildId: context.guildId,
      categoryId: context.categoryId,
    });
  }
  layers.push({ guildId: context.guildId });
  return layers;
};
