import { describe, expect, it } from "vitest";

import { protocordAiBoundary } from "../src/index.js";

describe("@protocord/ai package boundary", () => {
  it("depends only on the public action runtime entrypoint", () => {
    expect(protocordAiBoundary.actionRuntime).toBe("protocord");
  });
});
