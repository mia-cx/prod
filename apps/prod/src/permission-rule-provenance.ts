import type { PermissionVerb, RuleObject } from "@protocord/permissions";

export type PermissionRuleIdentity = Readonly<{
  guildId: string;
  subject: Readonly<{
    subjectType: "user" | "role";
    subjectId: string;
  }>;
  object: RuleObject;
  verb: PermissionVerb;
}>;

export type PermissionRuleOrigin = Readonly<{
  sourceType: "preset" | "custom" | "independent";
  sourceId: string;
}>;

export type PermissionRuleContribution = PermissionRuleOrigin &
  Readonly<{ permit: "allow" | "deny" }>;
