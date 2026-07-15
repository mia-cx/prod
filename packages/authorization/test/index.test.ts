import { describe, expect, it } from "vitest";

import { authorizationBoundary } from "../src/index.js";

describe("authorization package boundary", () => {
  it("exports only its reusable foundation", () => {
    expect(authorizationBoundary.name).toBe("@prod/authorization");
  });
});

