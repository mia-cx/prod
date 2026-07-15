import { describe, expect, it } from "vitest";

import { settingsBoundary } from "../src/index.js";

describe("@protocord/settings package boundary", () => {
  it("exports a consumer-owned settings foundation", () => {
    expect(settingsBoundary.name).toBe("@protocord/settings");
  });
});
