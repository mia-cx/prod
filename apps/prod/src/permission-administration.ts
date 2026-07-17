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
  addPresetSubjects(input: {
    guildId: string;
    preset: PermissionPreset;
    subjects: readonly PermissionSubject[];
    actorUserId: string;
    recheckAuthorization?: PermissionMutationAuthorization;
  }): Promise<void>;
  removePresetSubjects(input: {
    guildId: string;
    preset: PermissionPreset;
    subjects: readonly PermissionSubject[];
    actorUserId: string;
    recheckAuthorization?: PermissionMutationAuthorization;
  }): Promise<void>;
  clearPreset(input: {
    guildId: string;
    preset: PermissionPreset;
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

  const presetChanges = (
    guildId: string,
    preset: PermissionPreset,
    subjects: readonly PermissionSubject[],
    kind: "put" | "remove",
  ): PermissionContributionChange[] => {
    for (const subject of subjects) validateSubject(subject);
    const origin = presetOrigin(preset);
    return subjects.flatMap((subject) =>
      PERMISSION_PRESET_RULES[preset].map((presetRule) => {
        assertObjectVerb(presetRule.object, presetRule.verb);
        const identity = {
          guildId,
          subject,
          object: presetRule.object,
          verb: presetRule.verb,
        };
        return kind === "put"
          ? { kind, identity, origin, permit: "allow" as const }
          : { kind, identity, origin };
      }),
    );
  };

  const applyAuthorized = async (
    guildId: string,
    actorUserId: string,
    changes: readonly PermissionContributionChange[],
    recheckAuthorization?: PermissionMutationAuthorization,
  ) => {
    await authorize(guildId, actorUserId, recheckAuthorization);
    await options.contributions.apply({ changes, actorUserId });
  };

  const service: PermissionAdministrationService = {
    listPresetSubjects: async (guildId: string, preset: PermissionPreset) => {
      const identities = await options.contributions.listForSource(
        guildId,
        presetOrigin(preset),
      );
      const subjects = new Map<string, PermissionSubject>();
      for (const identity of identities) {
        const key = `${identity.subject.subjectType}:${identity.subject.subjectId}`;
        subjects.set(key, identity.subject);
      }
      return [...subjects.values()].sort(
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
      const desired = new Set(
        input.subjects.map(
          (subject) => `${subject.subjectType}:${subject.subjectId}`,
        ),
      );
      const origin = presetOrigin(input.preset);
      const current = await options.contributions.listForSource(
        input.guildId,
        origin,
      );
      const changes: PermissionContributionChange[] = [];
      for (const identity of current) {
        const key = `${identity.subject.subjectType}:${identity.subject.subjectId}`;
        if (!desired.has(key)) {
          changes.push({ kind: "remove", identity, origin });
        }
      }
      for (const subject of input.subjects) {
        for (const presetRule of PERMISSION_PRESET_RULES[input.preset]) {
          changes.push({
            kind: "put",
            identity: {
              guildId: input.guildId,
              subject,
              object: presetRule.object,
              verb: presetRule.verb,
            },
            origin,
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
    addPresetSubjects: async (input) =>
      applyAuthorized(
        input.guildId,
        input.actorUserId,
        presetChanges(input.guildId, input.preset, input.subjects, "put"),
        input.recheckAuthorization,
      ),
    removePresetSubjects: async (input) =>
      applyAuthorized(
        input.guildId,
        input.actorUserId,
        presetChanges(input.guildId, input.preset, input.subjects, "remove"),
        input.recheckAuthorization,
      ),
    clearPreset: async (input) => {
      await applyAuthorized(
        input.guildId,
        input.actorUserId,
        [
          {
            kind: "clear-source",
            guildId: input.guildId,
            origin: presetOrigin(input.preset),
          },
        ],
        input.recheckAuthorization,
      );
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
