import {
  parseHubPermissionOwnership,
  type HubPermissionOwnership,
} from "./hub-permission-ownership.js";

export type HubTransition = Readonly<{
  version: 1;
  id: string;
  previous: Readonly<{
    hubChannelId?: string;
    hubInformationMessageId?: string;
    hubPermissionOwnership?: HubPermissionOwnership;
  }>;
  next: HubPermissionOwnership;
}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseOwnership = (value: unknown): HubPermissionOwnership =>
  parseHubPermissionOwnership(JSON.stringify(value));

export const parseHubTransition = (value: string): HubTransition => {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.id !== "string" ||
    parsed.id.length === 0 ||
    !isRecord(parsed.previous) ||
    !isRecord(parsed.next)
  ) {
    throw new TypeError("Stored support hub transition is invalid");
  }
  const previousChannel = parsed.previous.hubChannelId;
  const previousMessage = parsed.previous.hubInformationMessageId;
  const previousOwnershipValue = parsed.previous.hubPermissionOwnership;
  if (
    (previousChannel !== undefined && typeof previousChannel !== "string") ||
    (previousMessage !== undefined && typeof previousMessage !== "string") ||
    (previousOwnershipValue === undefined) !==
      (previousChannel === undefined) ||
    (previousMessage !== undefined && previousChannel === undefined)
  ) {
    throw new TypeError("Stored support hub transition is invalid");
  }
  const previousOwnership =
    previousOwnershipValue === undefined
      ? undefined
      : parseOwnership(previousOwnershipValue);
  if (
    previousChannel !== undefined &&
    previousOwnership?.channelId !== previousChannel
  ) {
    throw new TypeError("Stored support hub transition is invalid");
  }
  const next = parseOwnership(parsed.next);
  if (next.channelId === previousChannel) {
    throw new TypeError("Stored support hub transition is invalid");
  }
  return Object.freeze({
    version: 1,
    id: parsed.id,
    previous: Object.freeze({
      ...(previousChannel === undefined
        ? {}
        : { hubChannelId: previousChannel }),
      ...(previousMessage === undefined
        ? {}
        : { hubInformationMessageId: previousMessage }),
      ...(previousOwnership === undefined
        ? {}
        : { hubPermissionOwnership: previousOwnership }),
    }),
    next,
  });
};
