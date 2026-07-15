import { describe, expect, it } from "vitest";

import { schemaContributors } from "../src/schema.js";

describe("Drizzle schema composition", () => {
  it("is selected explicitly by the deployable application", () => {
    expect(schemaContributors).toEqual([
      "@protocord/permissions",
      "@mia-cx/protocord-model-settings",
      "@prod/app",
    ]);
  });
});
