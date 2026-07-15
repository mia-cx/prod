export type AuthorizationContext = Readonly<{
  guildId: string;
  categoryId?: string;
  channelId?: string;
}>;

export type UserAuthorizationSubject = Readonly<{
  subjectType: "user";
  subjectId: string;
  attributes: Readonly<{
    discordRoleIds: readonly string[];
    isGuildOwner: boolean;
    isAdministrator: boolean;
  }>;
}>;

export type ServiceAuthorizationSubject = Readonly<{
  subjectType: "service";
  subjectId: string;
}>;

export type AuthorizationSubject =
  | UserAuthorizationSubject
  | ServiceAuthorizationSubject;

export type AuthorizationObject = Readonly<
  | { objectType: "ticket"; objectId: string }
  | { objectType: "queue"; objectId: "*" }
  | { objectType: "settings"; objectId: "*" }
  | { objectType: "permissions"; objectId: "*" }
>;

export type PermissionVerb =
  | "view"
  | "view_metadata"
  | "claim_self"
  | "unclaim_self"
  | "assign_other"
  | "unassign_other"
  | "label"
  | "pause_triage"
  | "resume_triage"
  | "close"
  | "reopen"
  | "suggest_assignee"
  | "complete_triage"
  | "manage";

export type AuthorizationCheck = Readonly<{
  context: AuthorizationContext;
  subject: AuthorizationSubject;
  object: AuthorizationObject;
  verb: PermissionVerb;
}>;

export type RuleSubject = Readonly<
  | {
      subjectType: "user" | "role" | "service";
      subjectId: string;
    }
  | { subjectType: "everyone"; subjectId: "*" }
>;

export type RuleObject = Readonly<{
  objectType: AuthorizationObject["objectType"];
  objectId: string;
}>;

export type PermissionRule = Readonly<{
  id: string;
  context: AuthorizationContext;
  subject: RuleSubject;
  object: RuleObject;
  verb: PermissionVerb;
  permit: "allow" | "deny";
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}>;

export type AuthorizationDecision = Readonly<{
  allowed: boolean;
  reason:
    | "guild_owner"
    | "administrator"
    | "matched_rule"
    | "default_deny";
  matchedRuleIds: readonly string[];
}>;

export interface PermissionRuleStore {
  upsert(rule: PermissionRule): Promise<void>;
  remove(ruleId: string, actorUserId?: string): Promise<void>;
  listForContext(
    context: AuthorizationContext,
  ): Promise<readonly PermissionRule[]>;
  listForObject(input: {
    context: AuthorizationContext;
    object: RuleObject;
  }): Promise<readonly PermissionRule[]>;
}

export interface AuthorizationService {
  check(input: AuthorizationCheck): Promise<AuthorizationDecision>;
  require(input: AuthorizationCheck): Promise<void>;
}

export type AuthorizationResourceValidator = (
  input: Readonly<{
    context: AuthorizationContext;
    object: AuthorizationObject;
  }>,
) => boolean | Promise<boolean>;
