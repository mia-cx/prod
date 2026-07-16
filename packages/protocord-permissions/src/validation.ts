import type {
  AuthorizationCheck,
  AuthorizationContext,
  AuthorizationObject,
  PermissionRule,
  PermissionRuleActor,
  PermissionRuleInput,
  PermissionVerb,
  RuleObject,
} from "./contracts.js";

const objectTypes = new Set(["ticket", "queue", "settings", "permissions"]);
const authorizationSubjectTypes = new Set(["user", "service"]);
const ruleSubjectTypes = new Set(["user", "role", "service", "everyone"]);
const userBooleanAttributes = [
  "isGuildOwner",
  "isAdministrator",
  "canManageGuild",
  "isApplicationOperator",
] as const;
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

const requireIdentifier = (value: unknown, field: string): void => {
  if (typeof value !== "string") {
    throw new InvalidAuthorizationInputError(
      `${field} must be a non-empty string`,
    );
  }
  if (value.length === 0) {
    throw new InvalidAuthorizationInputError(`${field} must not be empty`);
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

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

export const authorizationContextsEqual = (
  left: AuthorizationContext,
  right: AuthorizationContext,
): boolean =>
  left.guildId === right.guildId &&
  left.categoryId === right.categoryId &&
  left.channelId === right.channelId;

export const validateAuthorizationSubject = (
  subject: unknown,
): void => {
  if (!isRecord(subject)) {
    throw new InvalidAuthorizationInputError("subject must be an object");
  }
  if (!authorizationSubjectTypes.has(String(subject.subjectType))) {
    throw new InvalidAuthorizationInputError(
      `unsupported runtime subject type: ${String(subject.subjectType)}`,
    );
  }
  requireIdentifier(subject.subjectId, "subject.subjectId");
  if (subject.subjectId === "*") {
    throw new InvalidAuthorizationInputError(
      `${subject.subjectType} subjects must use an exact subjectId`,
    );
  }
  if (subject.subjectType === "user") {
    if (!isRecord(subject.attributes)) {
      throw new InvalidAuthorizationInputError(
        "subject.attributes must be an object for user subjects",
      );
    }
    if (!Array.isArray(subject.attributes.discordRoleIds)) {
      throw new InvalidAuthorizationInputError(
        "subject.attributes.discordRoleIds must be an array",
      );
    }
    for (const roleId of subject.attributes.discordRoleIds) {
      requireIdentifier(roleId, "subject.attributes.discordRoleIds[]");
    }
    for (const attribute of userBooleanAttributes) {
      if (typeof subject.attributes[attribute] !== "boolean") {
        throw new InvalidAuthorizationInputError(
          `subject.attributes.${attribute} must be a boolean`,
        );
      }
    }
  }
};

export const validateRuleSubject = (subject: unknown): void => {
  if (!isRecord(subject)) {
    throw new InvalidAuthorizationInputError("subject must be an object");
  }
  if (!ruleSubjectTypes.has(String(subject.subjectType))) {
    throw new InvalidAuthorizationInputError(
      `unsupported rule subject type: ${String(subject.subjectType)}`,
    );
  }
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
  validatePermissionRuleInput(rule);
  requireIdentifier(rule.createdByUserId, "rule.createdByUserId");
  requireIdentifier(rule.createdAt, "rule.createdAt");
  requireIdentifier(rule.updatedAt, "rule.updatedAt");
};

export const validatePermissionRuleInput = (
  rule: PermissionRuleInput,
): void => {
  requireIdentifier(rule.id, "rule.id");
  validateAuthorizationContext(rule.context);
  validateRuleSubject(rule.subject);
  validateRuleObject(rule.object);
  validatePermissionVerb(rule.verb);
  if (rule.permit !== "allow" && rule.permit !== "deny") {
    throw new InvalidAuthorizationInputError(
      `unsupported permit: ${String(rule.permit)}`,
    );
  }
};

export const validatePermissionRuleActor = (
  actor: PermissionRuleActor,
): void => {
  requireIdentifier(actor.actorId, "actor.actorId");
  if (actor.actorType !== "user") {
    throw new InvalidAuthorizationInputError(
      `unsupported actor type: ${String(actor.actorType)}`,
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
