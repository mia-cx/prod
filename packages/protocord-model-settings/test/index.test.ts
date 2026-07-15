import { describe, expect, it } from "vitest";

import { modelSettingsBoundary } from "../src/index.js";

describe("@mia-cx/protocord-model-settings package boundary", () => {
  it("composes through the public settings entrypoint", () => {
    expect(modelSettingsBoundary.settingsRuntime).toBe("@protocord/settings");
  });
});
