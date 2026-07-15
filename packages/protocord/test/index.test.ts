import { describe, expect, it } from "vitest";

import { protocordBoundary } from "../src/index.js";

describe("protocord package boundary", () => {
  it("does not ship a default action catalog", () => {
    expect(protocordBoundary).toEqual({
      name: "protocord",
      concreteActionCount: 0,
    });
  });
});
