import { randomUUID } from "node:crypto";

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
  PermissionRuleIdentity,
  PermissionRuleOrigin,
  PermissionRuleProvenanceStore,
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

export type PermissionAdministrationServiceOptions = Readonly<{
  rules: PermissionRuleStore;
  provenance: PermissionRuleProvenanceStore;
  authorize(input: {
    guildId: string;
    actorUserId: string;
  }): Promise<void>;
  createId?: () => string;
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
  }): Promise<void>;
  applyCustomRules(input: {
    guildId: string;
    subjects: readonly PermissionSubject[];
    object: RuleObject;
    verbs: readonly PermissionVerb[];
    permit: "allow" | "deny";
    actorUserId: string;
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

const independentOrigin: PermissionRuleOrigin = {
  sourceType: "independent",
  sourceId: "pre-existing",
};

const identityKey = (identity: PermissionRuleIdentity): string =>
  [
    identity.guildId,
    identity.subject.subjectType,
    identity.subject.subjectId,
    identity.object.objectType,
    identity.object.objectId,
    identity.verb,
  ].join("\u0000");

const ruleIdentity = (rule: PermissionRule): PermissionRuleIdentity => {
  if (
    rule.subject.subjectType !== "user" &&
    rule.subject.subjectType !== "role"
  ) {
    throw new TypeError("Prod permission administration supports users and roles only");
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

const assertPageNumber = (value: number, label: string, minimum: number): void => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be an integer of at least ${String(minimum)}`);
  }
};

export const createPermissionAdministrationService = (
  options: PermissionAdministrationServiceOptions,
): PermissionAdministrationService => {
  const createId = options.createId ?? randomUUID;
  const authorize = (guildId: string, actorUserId: string) =>
    options.authorize({ guildId, actorUserId });

  const listGuildRules = (guildId: string) =>
    options.rules.listForContext(createProdAuthorizationContext(guildId));

  const findRule = async (
    identity: PermissionRuleIdentity,
  ): Promise<PermissionRule | undefined> =>
    (await listGuildRules(identity.guildId)).find(
      (rule) => identityKey(ruleIdentity(rule)) === identityKey(identity),
    );

  const isUntrackedRule = async (
    identity: PermissionRuleIdentity,
  ): Promise<boolean> =>
      (await findRule(identity)) !== undefined &&
      (await options.provenance.list(identity)).length === 0;

  const upsert = async (
    identity: PermissionRuleIdentity,
    permit: "allow" | "deny",
    origin: PermissionRuleOrigin,
    actorUserId: string,
  ): Promise<void> => {
    const preserveIndependent = await isUntrackedRule(identity);
    await authorize(identity.guildId, actorUserId);
    if (preserveIndependent) {
      await options.provenance.add(identity, independentOrigin);
    }
    await options.rules.upsert({
      context: createProdAuthorizationContext(identity.guildId),
      rule: {
        id: createId(),
        context: createProdAuthorizationContext(identity.guildId),
        subject: identity.subject,
        object: identity.object,
        verb: identity.verb,
        permit,
      },
      actor: { actorType: "user", actorId: actorUserId },
    });
    await options.provenance.add(identity, origin);
  };

  const removeOrigin = async (
    identity: PermissionRuleIdentity,
    origin: PermissionRuleOrigin,
    actorUserId: string,
  ): Promise<void> => {
    await authorize(identity.guildId, actorUserId);
    await options.provenance.remove(identity, origin);
    if ((await options.provenance.list(identity)).length !== 0) return;
    const rule = await findRule(identity);
    if (rule === undefined) return;
    await authorize(identity.guildId, actorUserId);
    await options.rules.remove({
      ruleId: rule.id,
      context: createProdAuthorizationContext(identity.guildId),
      actor: { actorType: "user", actorId: actorUserId },
    });
  };

  const service: PermissionAdministrationService = {
    listPresetSubjects: async (
      guildId: string,
      preset: PermissionPreset,
    ) => {
      const identities = await options.provenance.listForSource(
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
    }) => {
      for (const subject of input.subjects) validateSubject(subject);
      const desired = new Set(
        input.subjects.map(
          (subject) => `${subject.subjectType}:${subject.subjectId}`,
        ),
      );
      const origin = presetOrigin(input.preset);
      const current = await options.provenance.listForSource(
        input.guildId,
        origin,
      );
      for (const identity of current) {
        const key = `${identity.subject.subjectType}:${identity.subject.subjectId}`;
        if (!desired.has(key)) {
          await removeOrigin(identity, origin, input.actorUserId);
        }
      }
      for (const subject of input.subjects) {
        for (const presetRule of PERMISSION_PRESET_RULES[input.preset]) {
          assertObjectVerb(presetRule.object, presetRule.verb);
          await upsert(
            {
              guildId: input.guildId,
              subject,
              object: presetRule.object,
              verb: presetRule.verb,
            },
            "allow",
            origin,
            input.actorUserId,
          );
        }
      }
    },
    applyCustomRules: async (input: {
      guildId: string;
      subjects: readonly PermissionSubject[];
      object: RuleObject;
      verbs: readonly PermissionVerb[];
      permit: "allow" | "deny";
      actorUserId: string;
    }) => {
      if (input.subjects.length === 0) {
        throw new TypeError("Select at least one user or role");
      }
      if (input.verbs.length === 0) {
        throw new TypeError("Select at least one permission verb");
      }
      for (const subject of input.subjects) validateSubject(subject);
      for (const verb of input.verbs) {
        assertObjectVerb(input.object, verb);
        for (const subject of input.subjects) {
          await upsert(
            {
              guildId: input.guildId,
              subject,
              object: input.object,
              verb,
            },
            input.permit,
            customOrigin,
            input.actorUserId,
          );
        }
      }
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
    }) => {
      const rule = (await listGuildRules(input.guildId)).find(
        ({ id }) => id === input.ruleId,
      );
      if (rule === undefined) return;
      const identity = ruleIdentity(rule);
      await authorize(input.guildId, input.actorUserId);
      await options.provenance.removeAll(identity);
      await authorize(input.guildId, input.actorUserId);
      await options.rules.remove({
        ruleId: rule.id,
        context: createProdAuthorizationContext(input.guildId),
        actor: { actorType: "user", actorId: input.actorUserId },
      });
    },
  };
  return Object.freeze(service);
};
