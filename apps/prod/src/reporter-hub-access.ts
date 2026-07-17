import {
  PermissionFlagsBits,
  type PermissionOverwriteOptions,
  type PermissionOverwrites,
} from "discord.js";

export const REPORTER_TICKET_HUB_OVERWRITE = Object.freeze({
  ViewChannel: true,
  ReadMessageHistory: true,
  SendMessagesInThreads: true,
  UseApplicationCommands: true,
  SendMessages: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
} as const);

export const REPORTER_TICKET_PERMISSION_NAMES = Object.freeze(
  Object.keys(
    REPORTER_TICKET_HUB_OVERWRITE,
  ) as readonly ReporterPermissionName[],
);

export type ReporterPermissionName = keyof typeof REPORTER_TICKET_HUB_OVERWRITE;
export type ReporterPermissionState = "allow" | "deny" | "unset";

export type ReporterHubAccessSnapshot = Readonly<{
  version: 1;
  overwriteExisted: boolean;
  permissions: Readonly<
    Record<ReporterPermissionName, ReporterPermissionState>
  >;
}>;

const permissionBits = Object.freeze({
  ViewChannel: PermissionFlagsBits.ViewChannel,
  ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
  SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
  UseApplicationCommands: PermissionFlagsBits.UseApplicationCommands,
  SendMessages: PermissionFlagsBits.SendMessages,
  CreatePublicThreads: PermissionFlagsBits.CreatePublicThreads,
  CreatePrivateThreads: PermissionFlagsBits.CreatePrivateThreads,
} satisfies Readonly<Record<ReporterPermissionName, bigint>>);

const permissionState = (
  overwrite: PermissionOverwrites | undefined,
  name: ReporterPermissionName,
): ReporterPermissionState => {
  const permission = permissionBits[name];
  if (overwrite?.allow.has(permission)) return "allow";
  if (overwrite?.deny.has(permission)) return "deny";
  return "unset";
};

export const captureReporterHubAccess = (
  overwrite: PermissionOverwrites | undefined,
): ReporterHubAccessSnapshot =>
  Object.freeze({
    version: 1,
    overwriteExisted: overwrite !== undefined,
    permissions: Object.freeze(
      Object.fromEntries(
        REPORTER_TICKET_PERMISSION_NAMES.map((name) => [
          name,
          permissionState(overwrite, name),
        ]),
      ) as Record<ReporterPermissionName, ReporterPermissionState>,
    ),
  });

export const isManagedReporterHubAccess = (
  overwrite: PermissionOverwrites,
): boolean =>
  REPORTER_TICKET_PERMISSION_NAMES.every((name) => {
    const expected = REPORTER_TICKET_HUB_OVERWRITE[name] ? "allow" : "deny";
    return permissionState(overwrite, name) === expected;
  });

const stateValue = (state: ReporterPermissionState): boolean | null => {
  if (state === "allow") return true;
  if (state === "deny") return false;
  return null;
};

export const reporterHubAccessRestorationPatch = (
  current: PermissionOverwrites | undefined,
  original: ReporterHubAccessSnapshot,
): PermissionOverwriteOptions =>
  Object.fromEntries(
    REPORTER_TICKET_PERMISSION_NAMES.flatMap((name) => {
      const managedState = REPORTER_TICKET_HUB_OVERWRITE[name]
        ? "allow"
        : "deny";
      return permissionState(current, name) === managedState
        ? [[name, stateValue(original.permissions[name])]]
        : [];
    }),
  );

export const isEmptyPermissionOverwrite = (
  overwrite: PermissionOverwrites | undefined,
): boolean =>
  overwrite !== undefined &&
  overwrite.allow.bitfield === 0n &&
  overwrite.deny.bitfield === 0n;

const states = new Set<ReporterPermissionState>(["allow", "deny", "unset"]);

export const parseReporterHubAccessSnapshot = (
  value: string,
): ReporterHubAccessSnapshot => {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("overwriteExisted" in parsed) ||
    typeof parsed.overwriteExisted !== "boolean" ||
    !("permissions" in parsed) ||
    typeof parsed.permissions !== "object" ||
    parsed.permissions === null ||
    Array.isArray(parsed.permissions) ||
    !REPORTER_TICKET_PERMISSION_NAMES.every((name) =>
      states.has(
        (parsed.permissions as Readonly<Record<string, unknown>>)[
          name
        ] as ReporterPermissionState,
      ),
    )
  ) {
    throw new TypeError("Stored reporter hub access snapshot is invalid");
  }
  return Object.freeze({
    version: 1,
    overwriteExisted: parsed.overwriteExisted,
    permissions: Object.freeze({
      ...(parsed.permissions as ReporterHubAccessSnapshot["permissions"]),
    }),
  });
};
