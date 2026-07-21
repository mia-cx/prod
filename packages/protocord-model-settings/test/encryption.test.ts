import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encryptApiKey } from "../src/index.js";

const encryptionKey = randomBytes(32);
const context = {
  guildId: "123456789012345678",
  purpose: "triage",
  provider: "openrouter",
};

describe("API key encryption", () => {
  it("rejects empty and whitespace-only keys", () => {
    expect(() => encryptApiKey("", encryptionKey, context)).toThrow(TypeError);
    expect(() => encryptApiKey("   ", encryptionKey, context)).toThrow(
      TypeError,
    );
  });

  it("masks keys below the reveal threshold entirely", () => {
    const belowThreshold = "a".repeat(23);
    expect(encryptApiKey(belowThreshold, encryptionKey, context).hint).toBe(
      "••••••••",
    );
  });

  it("reveals only fixed-width affixes at the threshold", () => {
    const atThreshold = `abcd${"x".repeat(16)}wxyz`;
    expect(encryptApiKey(atThreshold, encryptionKey, context).hint).toBe(
      "abcd••••••••wxyz",
    );
  });
});
