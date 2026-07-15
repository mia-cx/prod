import { describe, expect, it } from "vitest";

import { typescriptConfigBoundary } from "../src/index.js";

describe("config-typescript package boundary", () => {
  it("targets the Node 24 language baseline", () => {
    expect(typescriptConfigBoundary.target).toBe("ES2024");
  });
});
