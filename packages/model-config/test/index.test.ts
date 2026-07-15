import { describe, expect, it } from "vitest";

import { modelConfigBoundary } from "../src/index.js";

describe("model-config package boundary", () => {
  it("composes through the public settings entrypoint", () => {
    expect(modelConfigBoundary.settingsRuntime).toBe("@prod/discord-settings");
  });
});

