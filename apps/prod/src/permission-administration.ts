import {
  validatePermissionVerb,
  validateRuleObject,
  validateRuleSubject,
  type PermissionRule,
  type PermissionRuleStore,
  type PermissionVerb,
  type RuleObject,
} from "@protocord/permissions";

import { createProdAuthorizationContext } from "./authorization.js";
import type {
  PermissionContributionChange,
  PermissionContributionStore,
} from "./permission-contribution-store.js";
import type {
  PermissionRuleIdentity,
  PermissionRuleOrigin,
} from "./permission-rule-provenance.js";

export const PERMISSION_PRESETS = [
  "support_staff",
  "assignment_manager",
  "configurator",
] as const;

export type PermissionPreset = (typeof PERMISSION_PRESETS)[number];

export type PermissionSubject = Readonly<{
  subjectType: "user" | "role";
  subjectId: string;
}>;

export type PermissionPresetRule = Readonly<{
  object: RuleObject;
  verb: PermissionVerb;
}>;

const supportStaffRules: readonly PermissionPresetRule[] = [
  { object: { objectType: "queue", objectId: "*" }, verb: "view" },
  {
    object: { objectType: "ticket", objectId: "*" },
    verb: "view_metadata",
  },
  { object: { objectType: "ticket", objectId: "*" }, verb: "claim_self" },
  {
    object: { objectType: "ticket", objectId: "*" },
    verb: "unclaim_self",
  },
  { object: { objectType: "ticket", objectId: "*" }, verb: "label" },
  {
    object: { objectType: "ticket", objectId: "*" },
    verb: "pause_triage",
  },
  {
    object: { objectType: "ticket", objectId: "*" },
    verb: "resume_triage",
  },
  { object: { objectType: "ticket", objectId: "*" }, verb: "close" },
  { object: { objectType: "ticket", objectId: "*" }, verb: "reopen" },
];

const assignmentRules: readonly PermissionPresetRule[] = [
  ...supportStaffRules,
  {
    object: { objectType: "ticket", objectId: "*" },
    verb: "assign_other",
  },
  {
    object: { objectType: "ticket", objectId: "*" },
    verb: "unassign_other",
  },
];

export const PERMISSION_PRESET_RULES: Readonly<
  Record<PermissionPreset, readonly PermissionPresetRule[]>
> = Object.freeze({
  support_staff: supportStaffRules,
  assignment_manager: assignmentRules,
  configurator: [
    ...assignmentRules,
    { object: { objectType: "settings", objectId: "*" }, verb: "manage" },
    {
      object: { objectType: "permissions", objectId: "*" },
      verb: "manage",
    },
  ],
});

export const PERMISSION_OBJECT_VERBS: Readonly<
  Record<RuleObject["objectType"], readonly PermissionVerb[]>
> = Object.freeze({
  queue: ["view"],
  ticket: [
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
  ],
  settings: ["manage"],
  permissions: ["manage"],
});

export type PermissionRulePage = Readonly<{
  items: readonly PermissionRule[];
  total: number;
  offset: number;
  limit: number;
}>;

export type PermissionMutationAuthorization = () => Promise<void>;

export type PermissionAdministrationServiceOptions = Readonly<{
  rules: PermissionRuleStore;
  contributions: PermissionContributionStore;
  authorize(input: { guildId: string; actorUserId: string }): Promise<void>;
}>;

export interface PermissionAdministrationService {
  hasGuildRecords(guildId: string): Promise<boolean>;
  initializePresetsIfEmpty(input: {
    guildId: string;
    subjects: readonly PermissionSubject[];
    actorUserId: string;
  }): Promise<boolean>;
  listPresetSubjects(
    guildId: string,
    preset: PermissionPreset,
  ): Promise<readonly PermissionSubject[]>;
  setPresetSubjects(input: {
    guildId: string;
    preset: PermissionPreset;
    subjects: readonly PermissionSubject[];
    actorUserId: string;
    recheckAuthorization?: PermissionMutationAuthorization;
  }): Promise<void>;
  updatePresetSubjects(input: {
    guildId: string;
    preset: PermissionPreset;
    add: readonly PermissionSubject[];
    remove: readonly PermissionSubject[];
    actorUserId: string;
    recheckAuthorization?: PermissionMutationAuthorization;
  }): Promise<void>;
  applyCustomRules(input: {
    guildId: string;
    subjects: readonly PermissionSubject[];
    scope: "guild" | "exact-ticket";
    object: RuleObject;
    verbs: readonly PermissionVerb[];
    permit: "allow" | "deny";
    actorUserId: string;
    recheckAuthorization?: PermissionMutationAuthorization;
  }): Promise<void>;
  listRules(input: {
    guildId: string;
    offset?: number;
    limit?: number;
  }): Promise<PermissionRulePage>;
  removeRule(input: {
    guildId: string;
    ruleId: string;
    actorUserId: string;
    recheckAuthorization?: PermissionMutationAuthorization;
  }): Promise<void>;
}

const presetOrigin = (preset: PermissionPreset): PermissionRuleOrigin => ({
  sourceType: "preset",
  sourceId: preset,
});

const customOrigin: PermissionRuleOrigin = {
  sourceType: "custom",
  sourceId: "custom",
};

const ruleIdentity = (
  rule: PermissionRule,
): PermissionRuleIdentity | undefined => {
  if (
    rule.subject.subjectType !== "user" &&
    rule.subject.subjectType !== "role"
  ) {
    return undefined;
  }
  return {
    guildId: rule.context.guildId,
    subject: {
      subjectType: rule.subject.subjectType,
      subjectId: rule.subject.subjectId,
    },
    object: rule.object,
    verb: rule.verb,
  };
};

const compareRules = (left: PermissionRule, right: PermissionRule): number =>
  left.subject.subjectType.localeCompare(right.subject.subjectType) ||
  left.subject.subjectId.localeCompare(right.subject.subjectId) ||
  left.object.objectType.localeCompare(right.object.objectType) ||
  left.object.objectId.localeCompare(right.object.objectId) ||
  left.verb.localeCompare(right.verb) ||
  left.permit.localeCompare(right.permit) ||
  left.id.localeCompare(right.id);

const validateSubject = (subject: PermissionSubject): void => {
  validateRuleSubject(subject);
};

const assertObjectVerb = (object: RuleObject, verb: PermissionVerb): void => {
  validateRuleObject(object);
  validatePermissionVerb(verb);
  if (!PERMISSION_OBJECT_VERBS[object.objectType].includes(verb)) {
    throw new TypeError(`${verb} is not valid for ${object.objectType} rules`);
  }
};

const assertPageNumber = (
  value: number,
  label: string,
  minimum: number,
): void => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(
      `${label} must be an integer of at least ${String(minimum)}`,
    );
  }
};

export const createPermissionAdministrationService = (
  options: PermissionAdministrationServiceOptions,
): PermissionAdministrationService => {
  const authorize = (
    guildId: string,
    actorUserId: string,
    recheckAuthorization?: PermissionMutationAuthorization,
  ) => recheckAuthorization?.() ?? options.authorize({ guildId, actorUserId });

  const listGuildRules = (guildId: string) =>
    options.rules.listForContext(createProdAuthorizationContext(guildId));

  const service: PermissionAdministrationService = {
    hasGuildRecords: (guildId) =>
      options.contributions.hasGuildRecords(guildId),
    initializePresetsIfEmpty: async (input) => {
      if (await options.contributions.hasGuildRecords(input.guildId)) {
        return false;
      }
      for (const subject of input.subjects) validateSubject(subject);
      const changes: PermissionContributionChange[] = PERMISSION_PRESETS.map(
        (preset) => ({
          kind: "replace-source" as const,
          guildId: input.guildId,
          origin: presetOrigin(preset),
          contributions: input.subjects.flatMap((subject) =>
            PERMISSION_PRESET_RULES[preset].map(({ object, verb }) => ({
              identity: {
                guildId: input.guildId,
                subject,
                object,
                verb,
              },
              permit: "allow" as const,
            })),
          ),
        }),
      );
      await options.contributions.apply({
        changes,
        actorUserId: input.actorUserId,
      });
      return true;
    },
    listPresetSubjects: async (guildId: string, preset: PermissionPreset) => {
      const identities = await options.contributions.listForSource(
        guildId,
        presetOrigin(preset),
      );
      const subjects = new Map<
        string,
        { subject: PermissionSubject; rules: Set<string> }
      >();
      for (const identity of identities) {
        const key = `${identity.subject.subjectType}:${identity.subject.subjectId}`;
        const entry = subjects.get(key) ?? {
          subject: identity.subject,
          rules: new Set<string>(),
        };
        entry.rules.add(
          `${identity.object.objectType}:${identity.object.objectId}:${identity.verb}`,
        );
        subjects.set(key, entry);
      }
      const requiredRules = PERMISSION_PRESET_RULES[preset].map(
        ({ object, verb }) =>
          `${object.objectType}:${object.objectId}:${verb}`,
      );
      return [...subjects.values()]
        .filter(({ rules }) =>
          requiredRules.every((requiredRule) => rules.has(requiredRule)),
        )
        .map(({ subject }) => subject)
        .sort(
        (left, right) =>
          left.subjectType.localeCompare(right.subjectType) ||
          left.subjectId.localeCompare(right.subjectId),
        );
    },
    setPresetSubjects: async (input: {
      guildId: string;
      preset: PermissionPreset;
      subjects: readonly PermissionSubject[];
      actorUserId: string;
      recheckAuthorization?: PermissionMutationAuthorization;
    }) => {
      for (const subject of input.subjects) validateSubject(subject);
      for (const presetRule of PERMISSION_PRESET_RULES[input.preset]) {
        assertObjectVerb(presetRule.object, presetRule.verb);
      }
      const origin = presetOrigin(input.preset);
      const contributions: Extract<
        PermissionContributionChange,
        { kind: "replace-source" }
      >["contributions"][number][] = [];
      for (const subject of input.subjects) {
        for (const presetRule of PERMISSION_PRESET_RULES[input.preset]) {
          contributions.push({
            identity: {
              guildId: input.guildId,
              subject,
              object: presetRule.object,
              verb: presetRule.verb,
            },
            permit: "allow",
          });
        }
      }
      await authorize(
        input.guildId,
        input.actorUserId,
        input.recheckAuthorization,
      );
      await options.contributions.apply({
        changes: [
          {
            kind: "replace-source",
            guildId: input.guildId,
            origin,
            contributions,
          },
        ],
        actorUserId: input.actorUserId,
      });
    },
    updatePresetSubjects: async (input) => {
      const changes: PermissionContributionChange[] = [];
      for (const subject of input.remove) {
        validateSubject(subject);
        for (const presetRule of PERMISSION_PRESET_RULES[input.preset]) {
          assertObjectVerb(presetRule.object, presetRule.verb);
          changes.push({
            kind: "remove",
            identity: {
              guildId: input.guildId,
              subject,
              object: presetRule.object,
              verb: presetRule.verb,
            },
            origin: presetOrigin(input.preset),
          });
        }
      }
      for (const subject of input.add) {
        validateSubject(subject);
        for (const presetRule of PERMISSION_PRESET_RULES[input.preset]) {
          assertObjectVerb(presetRule.object, presetRule.verb);
          changes.push({
            kind: "put",
            identity: {
              guildId: input.guildId,
              subject,
              object: presetRule.object,
              verb: presetRule.verb,
            },
            origin: presetOrigin(input.preset),
            permit: "allow",
          });
        }
      }
      await authorize(
        input.guildId,
        input.actorUserId,
        input.recheckAuthorization,
      );
      await options.contributions.apply({
        changes,
        actorUserId: input.actorUserId,
      });
    },
    applyCustomRules: async (input: {
      guildId: string;
      subjects: readonly PermissionSubject[];
      scope: "guild" | "exact-ticket";
      object: RuleObject;
      verbs: readonly PermissionVerb[];
      permit: "allow" | "deny";
      actorUserId: string;
      recheckAuthorization?: PermissionMutationAuthorization;
    }) => {
      if (input.subjects.length === 0) {
        throw new TypeError("Select at least one user or role");
      }
      if (input.verbs.length === 0) {
        throw new TypeError("Select at least one permission verb");
      }
      if (input.scope === "guild" && input.object.objectId !== "*") {
        throw new TypeError("Guild-wide rules must use the object wildcard");
      }
      if (
        input.scope === "exact-ticket" &&
        (input.object.objectType !== "ticket" ||
          input.object.objectId.trim() === "" ||
          input.object.objectId.trim() === "*")
      ) {
        throw new TypeError(
          "Exact ticket rules require a non-wildcard ticket ID",
        );
      }
      for (const subject of input.subjects) validateSubject(subject);
      for (const verb of input.verbs) assertObjectVerb(input.object, verb);
      const changes: PermissionContributionChange[] = [];
      for (const verb of input.verbs) {
        for (const subject of input.subjects) {
          changes.push({
            kind: "put",
            identity: {
              guildId: input.guildId,
              subject,
              object: input.object,
              verb,
            },
            origin: customOrigin,
            permit: input.permit,
          });
        }
      }
      await authorize(
        input.guildId,
        input.actorUserId,
        input.recheckAuthorization,
      );
      await options.contributions.apply({
        changes,
        actorUserId: input.actorUserId,
      });
    },
    listRules: async (input: {
      guildId: string;
      offset?: number;
      limit?: number;
    }) => {
      const { guildId, offset = 0, limit = 10 } = input;
      assertPageNumber(offset, "offset", 0);
      assertPageNumber(limit, "limit", 1);
      const rules = [...(await listGuildRules(guildId))].sort(compareRules);
      return {
        items: rules.slice(offset, offset + limit),
        total: rules.length,
        offset,
        limit,
      };
    },
    removeRule: async (input: {
      guildId: string;
      ruleId: string;
      actorUserId: string;
      recheckAuthorization?: PermissionMutationAuthorization;
    }) => {
      const rule = (await listGuildRules(input.guildId)).find(
        ({ id }) => id === input.ruleId,
      );
      if (rule === undefined) return;
      await authorize(
        input.guildId,
        input.actorUserId,
        input.recheckAuthorization,
      );
      const identity = ruleIdentity(rule);
      if (identity === undefined) {
        await options.rules.remove({
          ruleId: rule.id,
          context: createProdAuthorizationContext(input.guildId),
          actor: { actorType: "user", actorId: input.actorUserId },
        });
        return;
      }
      await options.contributions.apply({
        changes: [{ kind: "remove-identity", identity }],
        actorUserId: input.actorUserId,
      });
    },
  };
  return Object.freeze(service);
};
