import { ButtonStyle } from "discord.js";
import type {
  SettingsAuthorization,
  SettingsCategory,
  SettingsField,
  SettingsMentionable,
  SettingsMutationResult,
  SettingsSelectOption,
} from "@protocord/settings";
import type {
  PermissionRule,
  PermissionVerb,
  RuleObject,
} from "@protocord/permissions";

import {
  PERMISSION_OBJECT_VERBS,
  type PermissionAdministrationService,
  type PermissionPreset,
  type PermissionSubject,
} from "../permission-administration.js";

export type PermissionSettingsContext = Readonly<{
  guildId?: string;
  userId: string;
}>;

export type CreatePermissionSettingsCategoryOptions<
  Context extends PermissionSettingsContext,
> = Readonly<{
  service: PermissionAdministrationService;
  authorize: SettingsAuthorization<Context>;
  now?: () => number;
}>;

type CustomRuleDraft = {
  subjects: readonly PermissionSubject[];
  objectType: RuleObject["objectType"];
  scope: "guild" | "ticket";
  ticketId?: string;
  verbs: readonly PermissionVerb[];
  permit: "allow" | "deny";
};

const PRESET_DETAILS: Readonly<
  Record<PermissionPreset, Readonly<{ label: string; description: string }>>
> = {
  support_staff: {
    label: "Support staff",
    description: "View queues and operate the ordinary ticket workflow.",
  },
  assignment_manager: {
    label: "Assignment managers",
    description: "Support staff who may assign and unassign other people.",
  },
  configurator: {
    label: "Configurators",
    description: "Assignment managers who may administer settings and permissions.",
  },
};

const PRESETS = Object.keys(PRESET_DETAILS) as readonly PermissionPreset[];
const SUBJECTS_PER_CONTROL = 25;
const PRESET_REMOVAL_CONTROLS = 20;
const RULES_PER_CONTROL = 25;
const RULE_REMOVAL_CONTROLS = 20;
const CLEAR_CONFIRMATION_MS = 2 * 60 * 1_000;

const requireGuildId = (context: PermissionSettingsContext): string => {
  if (context.guildId === undefined) {
    throw new TypeError("Permission settings require a guild interaction");
  }
  return context.guildId;
};

const subjectKey = (subject: PermissionSubject): string =>
  `${subject.subjectType}:${subject.subjectId}`;

const subjectLabel = (subject: PermissionSubject): string =>
  `${subject.subjectType === "user" ? "User" : "Role"} · ${subject.subjectId}`;

const mentionableSubject = (
  mentionable: SettingsMentionable,
): PermissionSubject => ({
  subjectType: mentionable.kind,
  subjectId: mentionable.id,
});

const mergeSubjects = (
  current: readonly PermissionSubject[],
  additions: readonly PermissionSubject[],
): readonly PermissionSubject[] => {
  const merged = new Map(current.map((subject) => [subjectKey(subject), subject]));
  for (const subject of additions) merged.set(subjectKey(subject), subject);
  return [...merged.values()];
};

const invalid = (message: string): SettingsMutationResult => ({
  status: "invalid",
  issues: [{ message }],
});

const presetSubjectOptions = (
  subjects: readonly PermissionSubject[],
): readonly SettingsSelectOption[] =>
  subjects.map((subject) => ({
    label: subjectLabel(subject),
    value: subjectKey(subject),
    description: `Remove this ${subject.subjectType} from the preset`,
  }));

const emptyOption = (label: string): readonly SettingsSelectOption[] => [
  { label, value: "none" },
];

const objectLabels: Readonly<Record<RuleObject["objectType"], string>> = {
  ticket: "Ticket",
  queue: "Queue",
  settings: "Settings",
  permissions: "Permissions",
};

const verbLabel = (verb: PermissionVerb): string =>
  verb
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");

const ruleLabel = (rule: PermissionRule): string =>
  `${rule.permit === "allow" ? "ALLOW" : "DENY"} · ${rule.subject.subjectType} · ${rule.subject.subjectId}`.slice(
    0,
    100,
  );

const ruleDescription = (rule: PermissionRule): string =>
  `${rule.object.objectType}/${rule.object.objectId}:${rule.verb}`.slice(0, 100);

const draftObject = (draft: CustomRuleDraft): RuleObject | undefined => {
  if (draft.scope === "ticket") {
    const ticketId = draft.ticketId?.trim();
    return draft.objectType === "ticket" && ticketId
      ? { objectType: "ticket", objectId: ticketId }
      : undefined;
  }
  return { objectType: draft.objectType, objectId: "*" };
};

const draftIssue = (draft: CustomRuleDraft): string | undefined => {
  if (draft.subjects.length === 0) return "Select at least one user or role.";
  if (draft.scope === "ticket" && draft.objectType !== "ticket") {
    return "Ticket-specific scope is available only for ticket rules.";
  }
  if (draft.scope === "ticket" && !draft.ticketId?.trim()) {
    return "Enter the exact ticket ID for ticket-specific scope.";
  }
  if (draft.verbs.length === 0) return "Select at least one verb.";
  return undefined;
};

const draftPreview = (draft: CustomRuleDraft): string => {
  const object = draftObject(draft);
  const issue = draftIssue(draft);
  const lines = [
    `Subjects: ${draft.subjects.length === 0 ? "None" : draft.subjects.map(subjectLabel).join(", ")}`,
    `Object: ${object === undefined ? "Incomplete" : `${object.objectType}/${object.objectId}`}`,
    `Verbs: ${draft.verbs.length === 0 ? "None" : draft.verbs.join(", ")}`,
    `Permit: ${draft.permit.toUpperCase()}`,
  ];
  return `${lines.join("\n")}\n\n${issue === undefined ? "Ready to persist." : `Not ready: ${issue}`}`;
};

export function createPermissionSettingsCategory<
  Context extends PermissionSettingsContext,
>(
  options: CreatePermissionSettingsCategoryOptions<Context>,
): SettingsCategory<Context> {
  const now = options.now ?? Date.now;
  const clearConfirmations = new Map<string, number>();
  const drafts = new Map<string, CustomRuleDraft>();
  const draftKey = (context: Context): string =>
    `${requireGuildId(context)}:${context.userId}`;
  const getDraft = (context: Context): CustomRuleDraft => {
    const key = draftKey(context);
    const existing = drafts.get(key);
    if (existing !== undefined) return existing;
    const created: CustomRuleDraft = {
      subjects: [],
      objectType: "ticket",
      scope: "guild",
      verbs: [],
      permit: "allow",
    };
    drafts.set(key, created);
    return created;
  };
  const updateDraft = (
    context: Context,
    update: Partial<CustomRuleDraft>,
  ): void => {
    drafts.set(draftKey(context), { ...getDraft(context), ...update });
  };

  const presetSubcategory = (preset: PermissionPreset) => {
    const details = PRESET_DETAILS[preset];
    const fields: SettingsField<Context>[] = [
      {
        kind: "display",
        id: "current",
        label: "Current subjects",
        load: async (context) => {
          const subjects = await options.service.listPresetSubjects(
            requireGuildId(context),
            preset,
          );
          return {
            value:
              subjects.length === 0
                ? "None configured."
                : subjects.map(subjectLabel).join("\n"),
          };
        },
      },
      {
        kind: "mentionable-select",
        id: "add",
        label: `Add ${details.label.toLowerCase()}`,
        description: "Select users and roles together. Existing members remain configured.",
        load: async (context) => ({
          value: `${String((await options.service.listPresetSubjects(requireGuildId(context), preset)).length)} configured`,
          placeholder: "Choose users and roles to add",
          minValues: 1,
          maxValues: 25,
        }),
        mutate: async (values, context) => {
          const guildId = requireGuildId(context);
          const current = await options.service.listPresetSubjects(guildId, preset);
          await options.service.setPresetSubjects({
            guildId,
            preset,
            subjects: mergeSubjects(current, values.map(mentionableSubject)),
            actorUserId: context.userId,
          });
        },
      },
    ];
    for (let chunk = 0; chunk < PRESET_REMOVAL_CONTROLS; chunk += 1) {
      fields.push({
        kind: "string-select",
        id: `remove-${String(chunk + 1)}`,
        label: `Remove subjects ${String(chunk * SUBJECTS_PER_CONTROL + 1)}–${String((chunk + 1) * SUBJECTS_PER_CONTROL)}`,
        visible: async (context) =>
          (await options.service.listPresetSubjects(
            requireGuildId(context),
            preset,
          )).length >
          chunk * SUBJECTS_PER_CONTROL,
        load: async (context) => {
          const subjects = await options.service.listPresetSubjects(
            requireGuildId(context),
            preset,
          );
          const page = subjects.slice(
            chunk * SUBJECTS_PER_CONTROL,
            (chunk + 1) * SUBJECTS_PER_CONTROL,
          );
          return {
            value:
              page.length === 0
                ? "No configured subjects in this range."
                : `${String(page.length)} removable ${page.length === 1 ? "subject" : "subjects"}`,
            options:
              page.length === 0
                ? emptyOption("No subjects in this range")
                : presetSubjectOptions(page),
            minValues: 1,
            maxValues: Math.max(1, page.length),
            disabled: page.length === 0,
          };
        },
        mutate: async (values, context) => {
          const guildId = requireGuildId(context);
          const removed = new Set(values);
          const current = await options.service.listPresetSubjects(guildId, preset);
          await options.service.setPresetSubjects({
            guildId,
            preset,
            subjects: current.filter((subject) => !removed.has(subjectKey(subject))),
            actorUserId: context.userId,
          });
        },
      });
    }
    fields.push({
      kind: "button",
      id: "clear",
      label: `Clear ${details.label.toLowerCase()}`,
      description: "Requires a second click and preserves rules with another origin.",
      style: ButtonStyle.Danger,
      load: (context) => {
        const key = `${draftKey(context)}:${preset}`;
        const armed = (clearConfirmations.get(key) ?? 0) > now();
        return {
          value: armed
            ? "Confirmation armed for two minutes. Click again to clear this preset."
            : "Click once to arm confirmation.",
          buttonLabel: armed ? "Confirm clear" : "Clear preset",
        };
      },
      mutate: async (context) => {
        const key = `${draftKey(context)}:${preset}`;
        if ((clearConfirmations.get(key) ?? 0) <= now()) {
          clearConfirmations.set(key, now() + CLEAR_CONFIRMATION_MS);
          return;
        }
        await options.service.setPresetSubjects({
          guildId: requireGuildId(context),
          preset,
          subjects: [],
          actorUserId: context.userId,
        });
        clearConfirmations.delete(key);
      },
    });
    return {
      id: preset,
      label: details.label,
      description: details.description,
      fields,
    };
  };

  const advancedFields: SettingsField<Context>[] = [
    {
      kind: "mentionable-select",
      id: "subjects",
      label: "Users and roles",
      load: (context) => ({
        value:
          getDraft(context).subjects.length === 0
            ? "None selected"
            : getDraft(context).subjects.map(subjectLabel).join(", "),
        defaults: getDraft(context).subjects.map((subject) => ({
          kind: subject.subjectType,
          id: subject.subjectId,
        })),
        minValues: 1,
        maxValues: 25,
      }),
      mutate: (values, context) => {
        updateDraft(context, { subjects: values.map(mentionableSubject) });
      },
    },
    {
      kind: "string-select",
      id: "object",
      label: "Object",
      load: (context) => ({
        value: objectLabels[getDraft(context).objectType],
        selectedValues: [getDraft(context).objectType],
        options: Object.entries(objectLabels).map(([value, label]) => ({
          value,
          label,
        })),
      }),
      mutate: (values, context) => {
        const objectType = values[0] as RuleObject["objectType"];
        const allowed = PERMISSION_OBJECT_VERBS[objectType];
        updateDraft(context, {
          objectType,
          verbs: getDraft(context).verbs.filter((verb) => allowed.includes(verb)),
        });
      },
    },
    {
      kind: "string-select",
      id: "scope",
      label: "Scope",
      description: "Prod offers guild-wide rules or an exact ticket object; category/channel contexts are unavailable.",
      load: (context) => ({
        value:
          getDraft(context).scope === "guild"
            ? "Guild-wide object wildcard"
            : "Exact ticket ID",
        selectedValues: [getDraft(context).scope],
        options: [
          { label: "Guild-wide", value: "guild" },
          { label: "Ticket-specific", value: "ticket" },
        ],
      }),
      mutate: (values, context) => {
        updateDraft(context, { scope: values[0] as "guild" | "ticket" });
      },
    },
    {
      kind: "modal",
      id: "ticket-id",
      label: "Ticket ID",
      title: "Set exact ticket scope",
      description: "Used only for ticket-specific rules.",
      inputs: [
        {
          id: "ticket",
          label: "Ticket ID",
          minLength: 1,
          maxLength: 100,
        },
      ],
      load: (context) => ({
        value:
          getDraft(context).scope === "ticket"
            ? (getDraft(context).ticketId ?? "Not set")
            : "Not used for guild-wide scope",
        values: { ticket: getDraft(context).ticketId ?? "" },
        disabled: getDraft(context).scope !== "ticket",
      }),
      validate: (values) =>
        values.ticket?.trim()
          ? []
          : [{ inputId: "ticket", message: "Enter an exact ticket ID." }],
      mutate: (values, context) => {
        updateDraft(context, { ticketId: values.ticket!.trim() });
      },
    },
    {
      kind: "string-select",
      id: "verbs",
      label: "Verbs",
      load: (context) => {
        const draft = getDraft(context);
        const verbs = PERMISSION_OBJECT_VERBS[draft.objectType];
        return {
          value: draft.verbs.length === 0 ? "None selected" : draft.verbs.join(", "),
          selectedValues: draft.verbs,
          options: verbs.map((verb) => ({ label: verbLabel(verb), value: verb })),
          minValues: 1,
          maxValues: verbs.length,
        };
      },
      mutate: (values, context) => {
        updateDraft(context, { verbs: values as readonly PermissionVerb[] });
      },
    },
    {
      kind: "string-select",
      id: "permit",
      label: "Permit",
      load: (context) => ({
        value: getDraft(context).permit.toUpperCase(),
        selectedValues: [getDraft(context).permit],
        options: [
          { label: "Allow", value: "allow" },
          { label: "Deny", value: "deny" },
        ],
      }),
      mutate: (values, context) => {
        updateDraft(context, { permit: values[0] as "allow" | "deny" });
      },
    },
    {
      kind: "display",
      id: "preview",
      label: "Rule preview",
      load: (context) => ({ value: draftPreview(getDraft(context)) }),
    },
    {
      kind: "button",
      id: "confirm",
      label: "Persist previewed rules",
      style: ButtonStyle.Success,
      load: (context) => ({
        value: draftIssue(getDraft(context)) ?? "The preview is ready.",
        buttonLabel: "Confirm rules",
        disabled: draftIssue(getDraft(context)) !== undefined,
      }),
      mutate: async (context) => {
        const draft = getDraft(context);
        const issue = draftIssue(draft);
        const object = draftObject(draft);
        if (issue !== undefined || object === undefined) {
          return invalid(issue ?? "Complete the rule preview.");
        }
        await options.service.applyCustomRules({
          guildId: requireGuildId(context),
          subjects: draft.subjects,
          object,
          verbs: draft.verbs,
          permit: draft.permit,
          actorUserId: context.userId,
        });
        drafts.delete(draftKey(context));
        return { status: "success" as const };
      },
    },
  ];

  const inspectionFields: SettingsField<Context>[] = [
    {
      kind: "display",
      id: "summary",
      label: "Active rules",
      load: async (context) => {
        const page = await options.service.listRules({
          guildId: requireGuildId(context),
          limit: RULES_PER_CONTROL * RULE_REMOVAL_CONTROLS,
        });
        return {
          value: `${String(page.total)} active ${page.total === 1 ? "rule" : "rules"}. Rules are grouped into paginated removal controls below.`,
        };
      },
    },
  ];
  for (let chunk = 0; chunk < RULE_REMOVAL_CONTROLS; chunk += 1) {
    inspectionFields.push({
      kind: "string-select",
      id: `rules-${String(chunk + 1)}`,
      label: `Inspect or remove rules ${String(chunk * RULES_PER_CONTROL + 1)}–${String((chunk + 1) * RULES_PER_CONTROL)}`,
      visible: async (context) =>
        (
          await options.service.listRules({
            guildId: requireGuildId(context),
            offset: chunk * RULES_PER_CONTROL,
            limit: 1,
          })
        ).items.length > 0,
      load: async (context) => {
        const page = await options.service.listRules({
          guildId: requireGuildId(context),
          offset: chunk * RULES_PER_CONTROL,
          limit: RULES_PER_CONTROL,
        });
        return {
          value:
            page.items.length === 0
              ? "No active rules in this range."
              : page.items
                  .map((rule) => `${ruleLabel(rule)} · ${ruleDescription(rule)}`)
                  .join("\n"),
          options:
            page.items.length === 0
              ? emptyOption("No rules in this range")
              : page.items.map((rule) => ({
                  label: ruleLabel(rule),
                  description: ruleDescription(rule),
                  value: rule.id,
                })),
          minValues: 1,
          maxValues: 1,
          disabled: page.items.length === 0,
        };
      },
      mutate: async (values, context) => {
        const ruleId = values[0];
        if (ruleId === undefined) return invalid("Select one rule to remove.");
        await options.service.removeRule({
          guildId: requireGuildId(context),
          ruleId,
          actorUserId: context.userId,
        });
      },
    });
  }

  return {
    id: "permissions",
    label: "Permissions",
    description: "Manage guild-wide presets and custom rules.",
    authorize: options.authorize,
    subcategories: [
      ...PRESETS.map(presetSubcategory),
      {
        id: "advanced",
        label: "Advanced rules",
        description: "Stage and preview guild-wide or exact-ticket allow/deny rules before persistence.",
        fields: advancedFields,
      },
      {
        id: "rules",
        label: "Inspect rules",
        description: "Inspect active rules and remove one audited rule at a time.",
        fields: inspectionFields,
      },
    ],
  };
}
