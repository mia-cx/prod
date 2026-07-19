import { Buffer } from "node:buffer";

import { SETTINGS_LIMITS } from "./definition.js";

export const SETTINGS_CUSTOM_ID_PREFIX = "pcs";
export const SETTINGS_ROUTE_VERSION = 1;

export type SettingsRouteAction =
  | "category"
  | "subcategory"
  | "home-page"
  | "subcategory-page"
  | "page"
  | "button"
  | "string-select"
  | "mentionable-select"
  | "channel-select"
  | "modal"
  | "modal-submit";

export type SettingsRoute = Readonly<{
  action: SettingsRouteAction;
  categoryId: string;
  subcategoryId: string;
  fieldId?: string;
  modalScope?: string;
  page: number;
}>;

export type DecodeSettingsRouteResult =
  | Readonly<{ ok: true; route: SettingsRoute }>
  | Readonly<{
      ok: false;
      reason: "not-settings" | "unknown-version" | "malformed";
    }>;

const ACTION_TOKENS: Readonly<Record<SettingsRouteAction, string>> = {
  category: "c",
  subcategory: "s",
  "home-page": "hp",
  "subcategory-page": "sp",
  page: "p",
  button: "b",
  "string-select": "ss",
  "mentionable-select": "ms",
  "channel-select": "cs",
  modal: "m",
  "modal-submit": "mt",
};

const TOKEN_ACTIONS = new Map(
  Object.entries(ACTION_TOKENS).map(([action, token]) => [
    token,
    action as SettingsRouteAction,
  ]),
);
const ROUTE_ID = /^[a-z0-9][a-z0-9_-]{0,23}$/;

export function encodeSettingsCustomId(route: SettingsRoute): string {
  assertRouteId("categoryId", route.categoryId);
  assertRouteId("subcategoryId", route.subcategoryId);
  if (route.fieldId !== undefined) {
    assertRouteId("fieldId", route.fieldId);
  }
  if (!Number.isSafeInteger(route.page) || route.page < 0) {
    throw new RangeError("settings route page must be a non-negative integer");
  }
  if (routeNeedsField(route.action) !== (route.fieldId !== undefined)) {
    throw new TypeError(
      `settings route action ${route.action} has an invalid fieldId`,
    );
  }
  if (
    route.modalScope !== undefined &&
    (route.action !== "modal-submit" ||
      route.modalScope.length === 0 ||
      route.modalScope.length > 100)
  ) {
    throw new TypeError("settings route has an invalid modal scope");
  }

  const customId = [
    SETTINGS_CUSTOM_ID_PREFIX,
    String(SETTINGS_ROUTE_VERSION),
    ACTION_TOKENS[route.action],
    route.categoryId,
    route.subcategoryId,
    route.fieldId ?? "-",
    route.page.toString(36),
    ...(route.modalScope === undefined
      ? []
      : [Buffer.from(route.modalScope).toString("base64url")]),
  ].join(".");
  if (customId.length > SETTINGS_LIMITS.customIdLength) {
    throw new RangeError(
      `settings custom ID exceeds ${SETTINGS_LIMITS.customIdLength} characters`,
    );
  }
  return customId;
}

export function decodeSettingsCustomId(
  customId: string,
): DecodeSettingsRouteResult {
  const parts = customId.split(".");
  if (parts[0] !== SETTINGS_CUSTOM_ID_PREFIX) {
    return { ok: false, reason: "not-settings" };
  }
  if (parts[1] !== String(SETTINGS_ROUTE_VERSION)) {
    return { ok: false, reason: "unknown-version" };
  }
  if (parts.length !== 7 && parts.length !== 8) {
    return { ok: false, reason: "malformed" };
  }

  const action = TOKEN_ACTIONS.get(parts[2] ?? "");
  const categoryId = parts[3] ?? "";
  const subcategoryId = parts[4] ?? "";
  const rawFieldId = parts[5] ?? "";
  const rawPage = parts[6] ?? "";
  const rawModalScope = parts[7];
  const page = parseBase36Integer(rawPage);
  const fieldId = rawFieldId === "-" ? undefined : rawFieldId;
  const modalScope = decodeModalScope(rawModalScope);
  if (
    action === undefined ||
    !ROUTE_ID.test(categoryId) ||
    !ROUTE_ID.test(subcategoryId) ||
    (fieldId !== undefined && !ROUTE_ID.test(fieldId)) ||
    page === undefined ||
    (rawModalScope !== undefined && modalScope === undefined) ||
    (modalScope !== undefined && action !== "modal-submit") ||
    routeNeedsField(action) !== (fieldId !== undefined)
  ) {
    return { ok: false, reason: "malformed" };
  }

  return {
    ok: true,
    route: {
      action,
      categoryId,
      subcategoryId,
      ...(fieldId === undefined ? {} : { fieldId }),
      ...(modalScope === undefined ? {} : { modalScope }),
      page,
    },
  };
}

function decodeModalScope(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return decoded.length > 0 &&
    decoded.length <= 100 &&
    Buffer.from(decoded).toString("base64url") === value
    ? decoded
    : undefined;
}

export function isSettingsCustomId(customId: string): boolean {
  return customId.startsWith(`${SETTINGS_CUSTOM_ID_PREFIX}.`);
}

function routeNeedsField(action: SettingsRouteAction): boolean {
  return ![
    "category",
    "subcategory",
    "home-page",
    "subcategory-page",
    "page",
  ].includes(action);
}

function assertRouteId(label: string, value: string): void {
  if (!ROUTE_ID.test(value)) {
    throw new TypeError(`settings route ${label} is not a stable ID`);
  }
}

function parseBase36Integer(value: string): number | undefined {
  if (!/^[0-9a-z]+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 36);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
