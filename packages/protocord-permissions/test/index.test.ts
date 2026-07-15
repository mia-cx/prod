import { describe, expect, it } from "vitest";

import { permissionsBoundary } from "../src/index.js";

describe("@protocord/permissions package boundary", () => {
  it("exports only its reusable foundation", () => {
    expect(permissionsBoundary.name).toBe("@protocord/permissions");
  });
});
