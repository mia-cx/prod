import { describe, expect, it } from "vitest";

import {
  decodeSettingsCustomId,
  encodeSettingsCustomId,
  isSettingsCustomId,
  type SettingsRoute,
} from "../src/index.js";

describe("versioned settings routes", () => {
  it.each<SettingsRoute>([
    {
      action: "category",
      categoryId: "setup",
      subcategoryId: "general",
      page: 0,
    },
    {
      action: "home-page",
      categoryId: "setup",
      subcategoryId: "general",
      page: 1,
    },
    {
      action: "subcategory-page",
      categoryId: "identity",
      subcategoryId: "personality",
      page: 1,
    },
    {
      action: "mentionable-select",
      categoryId: "permissions",
      subcategoryId: "presets",
      fieldId: "support-staff",
      page: 35,
    },
    {
      action: "modal-submit",
      categoryId: "labels",
      subcategoryId: "editor",
      fieldId: "rename",
      page: 2,
    },
  ])("round-trips $action routes", (route) => {
    const customId = encodeSettingsCustomId(route);

    expect(customId.length).toBeLessThanOrEqual(100);
    expect(isSettingsCustomId(customId)).toBe(true);
    expect(decodeSettingsCustomId(customId)).toEqual({ ok: true, route });
  });

  it("distinguishes unrelated, unknown-version, and malformed IDs", () => {
    expect(decodeSettingsCustomId("another.1.c.a.b.-.0")).toEqual({
      ok: false,
      reason: "not-settings",
    });
    expect(decodeSettingsCustomId("pcs.99.c.a.b.-.0")).toEqual({
      ok: false,
      reason: "unknown-version",
    });
    expect(decodeSettingsCustomId("pcs.1.ms.a.b.-.0")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(decodeSettingsCustomId("pcs.1.c.a.b.field.0")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects unsafe IDs and pages before encoding", () => {
    expect(() =>
      encodeSettingsCustomId({
        action: "page",
        categoryId: "NOT SAFE",
        subcategoryId: "general",
        page: 0,
      }),
    ).toThrow(/stable ID/);
    expect(() =>
      encodeSettingsCustomId({
        action: "button",
        categoryId: "setup",
        subcategoryId: "general",
        page: -1,
      }),
    ).toThrow(/page/);
  });
});
