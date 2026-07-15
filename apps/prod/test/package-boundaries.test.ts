import { describe, expect, it } from "vitest";

import { packageBoundaries } from "../src/package-boundaries.js";

describe("Prod package composition", () => {
  it("consumes reusable packages only through public entrypoints", () => {
    expect(packageBoundaries).toEqual([
      "@protocord/permissions",
      "protocord",
      "@protocord/ai",
      "@protocord/settings",
      "@protocord/model-config",
    ]);
  });
});
