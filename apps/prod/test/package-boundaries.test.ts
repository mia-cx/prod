import { describe, expect, it } from "vitest";

import { packageBoundaries } from "../src/package-boundaries.js";

describe("Prod package composition", () => {
  it("consumes reusable packages only through public entrypoints", () => {
    expect(packageBoundaries).toEqual([
      "@prod/authorization",
      "@prod/discord-actions",
      "@prod/discord-actions-ai",
      "@prod/discord-settings",
      "@prod/model-config",
    ]);
  });
});

