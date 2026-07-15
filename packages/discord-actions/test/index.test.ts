import { describe, expect, it } from "vitest";

import { discordActionsBoundary } from "../src/index.js";

describe("discord-actions package boundary", () => {
  it("does not ship a default action catalog", () => {
    expect(discordActionsBoundary).toEqual({
      name: "@prod/discord-actions",
      concreteActionCount: 0,
    });
  });
});

