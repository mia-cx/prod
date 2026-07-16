export const HUB_PROTECTED_PERMISSION_NAMES = Object.freeze([
  "SendMessages",
  "SendMessagesInThreads",
  "CreatePublicThreads",
  "CreatePrivateThreads",
] as const);

export const HUB_BOT_PERMISSION_NAMES = Object.freeze([
  "SendMessages",
  "SendMessagesInThreads",
  "CreatePrivateThreads",
] as const);

export type HubProtectedPermissionName =
  (typeof HUB_PROTECTED_PERMISSION_NAMES)[number];

export type HubPermissionState = "allow" | "deny" | "unset";

export type HubPermissionOwnership = Readonly<{
  version: 1;
  channelId: string;
  botMemberId: string;
  everyone: Readonly<Record<HubProtectedPermissionName, HubPermissionState>>;
  bot: Readonly<Record<HubProtectedPermissionName, HubPermissionState>>;
}>;

const permissionStates = new Set<HubPermissionState>([
  "allow",
  "deny",
  "unset",
]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPermissionSnapshot = (
  value: unknown,
): value is HubPermissionOwnership["everyone"] =>
  isRecord(value) &&
  HUB_PROTECTED_PERMISSION_NAMES.every((name) =>
    permissionStates.has(value[name] as HubPermissionState),
  );

export const parseHubPermissionOwnership = (
  value: string,
): HubPermissionOwnership => {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.channelId !== "string" ||
    parsed.channelId.length === 0 ||
    typeof parsed.botMemberId !== "string" ||
    parsed.botMemberId.length === 0 ||
    !isPermissionSnapshot(parsed.everyone) ||
    !isPermissionSnapshot(parsed.bot)
  ) {
    throw new TypeError("Stored support hub permission ownership is invalid");
  }
  return Object.freeze({
    version: 1,
    channelId: parsed.channelId,
    botMemberId: parsed.botMemberId,
    everyone: Object.freeze({ ...parsed.everyone }),
    bot: Object.freeze({ ...parsed.bot }),
  });
};
