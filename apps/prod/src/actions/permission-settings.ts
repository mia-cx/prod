import type {
  SettingsAuthorization,
  SettingsCategory,
  SettingsField,
  SettingsMentionable,
  SettingsMutationResult,
} from "@protocord/settings";

import type {
  PermissionAdministrationService,
  PermissionPreset,
  PermissionSubject,
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

const PRESET_DETAILS: Readonly<
  Record<PermissionPreset, Readonly<{ label: string; description: string }>>
> = {
  support_staff: {
    label: "Support staff",
    description: "Can view queues and handle the ordinary ticket workflow.",
  },
  assignment_manager: {
    label: "Assignment managers",
    description: "Can also assign and unassign other support staff.",
  },
  configurator: {
    label: "Configurators",
    description: "Can also manage Prod's settings and access.",
  },
};

const PRESETS = Object.keys(PRESET_DETAILS) as readonly PermissionPreset[];
const PRESET_SELECTOR_LIMIT = 25;
const SESSION_STATE_LIMIT = 100;

const requireGuildId = (context: PermissionSettingsContext): string => {
  if (context.guildId === undefined) {
    throw new TypeError("Permission settings require a guild interaction");
  }
  return context.guildId;
};

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

export function createPermissionSettingsCategory<
  Context extends PermissionSettingsContext,
>(
  options: CreatePermissionSettingsCategoryOptions<Context>,
): SettingsCategory<Context> {
  const baselines = new Map<string, readonly PermissionSubject[]>();
  const sessions = new Map<string, true>();

  const clearSession = (key: string): void => {
    sessions.delete(key);
    for (const preset of PRESETS) baselines.delete(`${key}:${preset}`);
  };

  const sessionKey = (context: Context): string => {
    const key = `${requireGuildId(context)}:${context.userId}:${context.settingsSessionId}`;
    sessions.delete(key);
    sessions.set(key, true);
    if (sessions.size > SESSION_STATE_LIMIT) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (oldest !== undefined) clearSession(oldest);
    }
    return key;
  };

  const presetField = (preset: PermissionPreset): SettingsField<Context> => {
    const details = PRESET_DETAILS[preset];
    const baselineKey = (context: Context) => `${sessionKey(context)}:${preset}`;

    return {
      kind: "mentionable-select",
      id: preset,
      label: details.label,
      description: details.description,
      load: async (context, purpose = "render") => {
        const subjects = await options.service.listPresetSubjects(
          requireGuildId(context),
          preset,
        );
        const visibleSubjects = subjects.slice(0, PRESET_SELECTOR_LIMIT);
        if (purpose === "render") {
          baselines.set(baselineKey(context), visibleSubjects);
        }
        return {
          defaults: visibleSubjects.map((subject) => ({
            kind: subject.subjectType,
            id: subject.subjectId,
          })),
          placeholder: "Choose users and roles",
          minValues: 0,
          maxValues: PRESET_SELECTOR_LIMIT,
        };
      },
      mutate: async (values, context) => {
        const key = baselineKey(context);
        const baseline = baselines.get(key);
        if (baseline === undefined) {
          return invalid(
            "This selector expired. Review the refreshed selection and try again.",
          );
        }
        const selected = values.map(mentionableSubject);
        const baselineByKey = new Map(
          baseline.map((subject) => [
            `${subject.subjectType}:${subject.subjectId}`,
            subject,
          ]),
        );
        const selectedByKey = new Map(
          selected.map((subject) => [
            `${subject.subjectType}:${subject.subjectId}`,
            subject,
          ]),
        );
        await options.service.updatePresetSubjects({
          guildId: requireGuildId(context),
          preset,
          add: [...selectedByKey]
            .filter(([subjectKey]) => !baselineByKey.has(subjectKey))
            .map(([, subject]) => subject),
          remove: [...baselineByKey]
            .filter(([subjectKey]) => !selectedByKey.has(subjectKey))
            .map(([, subject]) => subject),
          actorUserId: context.userId,
          recheckAuthorization: () => options.requireAuthorization(context),
        });
        baselines.set(key, selected);
      },
    };
  };

  return {
    id: "permissions",
    label: "Permissions",
    description: "Choose who can support users and configure Prod.",
    authorize: options.authorize,
    fields: PRESETS.map(presetField),
  };
}
