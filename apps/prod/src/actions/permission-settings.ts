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
  settingsSessionId: string;
}>;

export type CreatePermissionSettingsCategoryOptions<
  Context extends PermissionSettingsContext,
> = Readonly<{
  service: PermissionAdministrationService;
  authorize: SettingsAuthorization<Context>;
  requireAuthorization(context: Context): Promise<void>;
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
    description:
      "Assignment managers who may administer settings and permissions.",
  },
};

const PRESETS = Object.keys(PRESET_DETAILS) as readonly PermissionPreset[];
const RULES_PER_CONTROL = 25;
const SESSION_STATE_LIMIT = 100;

const requireGuildId = (context: PermissionSettingsContext): string => {
  if (context.guildId === undefined) {
    throw new TypeError("Permission settings require a guild interaction");
  }
  return context.guildId;
};

const subjectLabel = (subject: PermissionSubject): string =>
  `${subject.subjectType === "user" ? "User" : "Role"} · ${subject.subjectId}`;

const mentionableSubject = (
  mentionable: SettingsMentionable,
): PermissionSubject => ({
  subjectType: mentionable.kind,
  subjectId: mentionable.id,
});

const invalid = (message: string): SettingsMutationResult => ({
  status: "invalid",
  issues: [{ message }],
});

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
  `${rule.object.objectType}/${rule.object.objectId}:${rule.verb}`.slice(
    0,
    100,
  );

const draftObject = (draft: CustomRuleDraft): RuleObject | undefined => {
  if (draft.scope === "ticket") {
    const ticketId = draft.ticketId?.trim();
    return draft.objectType === "ticket" && ticketId
      ? { objectType: "ticket", objectId: ticketId }
      : undefined;
  }
  return { objectType: draft.objectType, objectId: "*" };
};

const exactTicketIdIssue = (value: string | undefined): string | undefined => {
  const ticketId = value?.trim();
  if (!ticketId) return "Enter an exact ticket ID.";
  if (ticketId === "*")
    return 'Exact ticket scope cannot use the wildcard "*".';
  return undefined;
};

const draftIssue = (draft: CustomRuleDraft): string | undefined => {
  if (draft.subjects.length === 0) return "Select at least one user or role.";
  if (draft.scope === "ticket" && draft.objectType !== "ticket") {
    return "Ticket-specific scope is available only for ticket rules.";
  }
  if (draft.scope === "ticket") {
    const issue = exactTicketIdIssue(draft.ticketId);
    if (issue !== undefined) return issue;
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
  const drafts = new Map<string, CustomRuleDraft>();
  const ruleRemovalPages = new Map<string, number>();
  const sessions = new Map<string, true>();
  const clearSessionState = (key: string): void => {
    sessions.delete(key);
    drafts.delete(key);
    ruleRemovalPages.delete(key);
  };
  const draftKey = (context: Context): string => {
    const key = `${requireGuildId(context)}:${context.userId}:${context.settingsSessionId}`;
    sessions.delete(key);
    sessions.set(key, true);
    if (sessions.size > SESSION_STATE_LIMIT) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (oldest !== undefined) clearSessionState(oldest);
    }
    return key;
  };
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
        id: "subjects",
        label: details.label,
        description: "Select every user and role that belongs to this preset.",
        load: async (context) => {
          const subjects = await options.service.listPresetSubjects(
            requireGuildId(context),
            preset,
          );
          return {
            value: `${String(subjects.length)} configured`,
            defaults: subjects.map((subject) => ({
              kind: subject.subjectType,
              id: subject.subjectId,
            })),
            placeholder: "Choose users and roles",
            minValues: 0,
            maxValues: 25,
          };
        },
        mutate: async (values, context) => {
          await options.service.setPresetSubjects({
            guildId: requireGuildId(context),
            preset,
            subjects: values.map(mentionableSubject),
            actorUserId: context.userId,
            recheckAuthorization: () => options.requireAuthorization(context),
          });
        },
      },
    ];
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
          verbs: getDraft(context).verbs.filter((verb) =>
            allowed.includes(verb),
          ),
        });
      },
    },
    {
      kind: "string-select",
      id: "scope",
      label: "Scope",
      description:
        "Prod offers guild-wide rules or an exact ticket object; category/channel contexts are unavailable.",
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
      validate: (values) => {
        const issue = exactTicketIdIssue(values.ticket);
        return issue === undefined
          ? []
          : [{ inputId: "ticket", message: issue }];
      },
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
          value:
            draft.verbs.length === 0 ? "None selected" : draft.verbs.join(", "),
          selectedValues: draft.verbs,
          options: verbs.map((verb) => ({
            label: verbLabel(verb),
            value: verb,
          })),
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
          scope: draft.scope === "guild" ? "guild" : "exact-ticket",
          object,
          verbs: draft.verbs,
          permit: draft.permit,
          actorUserId: context.userId,
          recheckAuthorization: () => options.requireAuthorization(context),
        });
        clearSessionState(draftKey(context));
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
          limit: 1,
        });
        return {
          value: `${String(page.total)} active ${page.total === 1 ? "rule" : "rules"}. Rules are grouped into paginated removal controls below.`,
        };
      },
    },
  ];
  const rulePageKey = (context: Context) => draftKey(context);
  const getRulePage = (context: Context) =>
    ruleRemovalPages.get(rulePageKey(context)) ?? 0;
  inspectionFields.push(
    {
      kind: "string-select",
      id: "rules",
      label: "Inspect or remove rules on current page",
      load: async (context) => {
        const guildId = requireGuildId(context);
        const summary = await options.service.listRules({ guildId, limit: 1 });
        const lastPage = Math.max(
          0,
          Math.ceil(summary.total / RULES_PER_CONTROL) - 1,
        );
        const pageNumber = Math.min(getRulePage(context), lastPage);
        ruleRemovalPages.set(rulePageKey(context), pageNumber);
        const page = await options.service.listRules({
          guildId: requireGuildId(context),
          offset: pageNumber * RULES_PER_CONTROL,
          limit: RULES_PER_CONTROL,
        });
        return {
          value:
            page.items.length === 0
              ? "No active rules in this range."
              : `Page ${String(pageNumber + 1)} of ${String(lastPage + 1)}\n${page.items.map((rule) => `${ruleLabel(rule)} · ${ruleDescription(rule)}`).join("\n")}`,
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
          recheckAuthorization: () => options.requireAuthorization(context),
        });
      },
    },
    {
      kind: "button",
      id: "rules-previous",
      label: "Previous rule page",
      load: (context) => ({
        value: "Show the previous page of active rules.",
        buttonLabel: "Previous",
        disabled: getRulePage(context) === 0,
      }),
      mutate: (context) => {
        ruleRemovalPages.set(
          rulePageKey(context),
          Math.max(0, getRulePage(context) - 1),
        );
      },
    },
    {
      kind: "button",
      id: "rules-next",
      label: "Next rule page",
      load: async (context) => {
        const page = await options.service.listRules({
          guildId: requireGuildId(context),
          limit: 1,
        });
        return {
          value: "Show the next page of active rules.",
          buttonLabel: "Next",
          disabled:
            (getRulePage(context) + 1) * RULES_PER_CONTROL >= page.total,
        };
      },
      mutate: (context) => {
        ruleRemovalPages.set(rulePageKey(context), getRulePage(context) + 1);
      },
    },
  );

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
        description:
          "Stage and preview guild-wide or exact-ticket allow/deny rules before persistence.",
        fields: advancedFields,
      },
      {
        id: "rules",
        label: "Inspect rules",
        description:
          "Inspect active rules and remove one audited rule at a time.",
        fields: inspectionFields,
      },
    ],
  };
}
