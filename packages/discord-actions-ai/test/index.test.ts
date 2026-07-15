import { describe, expect, it } from "vitest";

import { discordActionsAiBoundary } from "../src/index.js";

describe("discord-actions-ai package boundary", () => {
  it("depends only on the public action runtime entrypoint", () => {
    expect(discordActionsAiBoundary.actionRuntime).toBe("@prod/discord-actions");
  });
});

