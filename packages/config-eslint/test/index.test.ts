import { describe, expect, it } from "vitest";

import { eslintConfigBoundary } from "../src/index.js";

describe("config-eslint package boundary", () => {
  it("declares the flat-config format", () => {
    expect(eslintConfigBoundary.format).toBe("flat");
  });
});

