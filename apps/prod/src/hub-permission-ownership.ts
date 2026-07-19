const HUB_V1_PROTECTED_PERMISSION_NAMES = Object.freeze([
  "SendMessages",
  "SendMessagesInThreads",
  "CreatePublicThreads",
  "CreatePrivateThreads",
] as const);

export const HUB_PROTECTED_PERMISSION_NAMES = Object.freeze([
  ...HUB_V1_PROTECTED_PERMISSION_NAMES,
  "ManageThreads",
] as const);

export const HUB_BOT_PERMISSION_NAMES = Object.freeze([
  "SendMessages",
  "SendMessagesInThreads",
  "CreatePrivateThreads",
  "ManageThreads",
] as const);

export type HubProtectedPermissionName =
  (typeof HUB_PROTECTED_PERMISSION_NAMES)[number];

export type HubPermissionState = "allow" | "deny" | "unset";

type HubV1ProtectedPermissionName =
  (typeof HUB_V1_PROTECTED_PERMISSION_NAMES)[number];

type HubPermissionOwnershipV1 = Readonly<{
  version: 1;
  channelId: string;
  botMemberId: string;
  everyone: Readonly<Record<HubV1ProtectedPermissionName, HubPermissionState>>;
  bot: Readonly<Record<HubV1ProtectedPermissionName, HubPermissionState>>;
}>;

export type HubPermissionOwnershipV2 = Readonly<{
  version: 2;
  channelId: string;
  botMemberId: string;
  everyone: Readonly<Record<HubProtectedPermissionName, HubPermissionState>>;
  bot: Readonly<Record<HubProtectedPermissionName, HubPermissionState>>;
}>;

export type HubPermissionOwnership =
  | HubPermissionOwnershipV1
  | HubPermissionOwnershipV2;

const permissionStates = new Set<HubPermissionState>([
  "allow",
  "deny",
  "unset",
]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPermissionSnapshot = <Name extends string>(
  value: unknown,
  names: readonly Name[],
): value is Readonly<Record<Name, HubPermissionState>> =>
  isRecord(value) &&
  names.every((name) =>
    permissionStates.has(value[name] as HubPermissionState),
  );

export const parseHubPermissionOwnership = (
  value: string,
): HubPermissionOwnership => {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
    typeof parsed.channelId !== "string" ||
    parsed.channelId.length === 0 ||
    typeof parsed.botMemberId !== "string" ||
    parsed.botMemberId.length === 0 ||
    !isPermissionSnapshot(
      parsed.everyone,
      parsed.version === 1
        ? HUB_V1_PROTECTED_PERMISSION_NAMES
        : HUB_PROTECTED_PERMISSION_NAMES,
    ) ||
    !isPermissionSnapshot(
      parsed.bot,
      parsed.version === 1
        ? HUB_V1_PROTECTED_PERMISSION_NAMES
        : HUB_PROTECTED_PERMISSION_NAMES,
    )
  ) {
    throw new TypeError("Stored support hub permission ownership is invalid");
  }
  return Object.freeze({
    version: parsed.version,
    channelId: parsed.channelId,
    botMemberId: parsed.botMemberId,
    everyone: Object.freeze({ ...parsed.everyone }),
    bot: Object.freeze({ ...parsed.bot }),
  });
};
