import { describe, expect, it } from "vitest";

import { discordSettingsBoundary } from "../src/index.js";

describe("discord-settings package boundary", () => {
  it("exports a consumer-owned settings foundation", () => {
    expect(discordSettingsBoundary.name).toBe("@prod/discord-settings");
  });
});

