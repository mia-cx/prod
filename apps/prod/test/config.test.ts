import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../src/config.js";

const requiredEnvironment = {
  DISCORD_TOKEN: "development-secret-token",
  DISCORD_CLIENT_ID: "123456789012345678",
  API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("loadConfig", () => {
  it("validates required values and supplies safe defaults", () => {
    expect(loadConfig(requiredEnvironment)).toEqual({
      discordToken: "development-secret-token",
      discordClientId: "123456789012345678",
      botOperatorUserIds: [],
      textCommandPrefix: "",
      databaseUrl: "file:./data/prod.sqlite",
      logLevel: "info",
      apiKeyEncryptionKey: requiredEnvironment.API_KEY_ENCRYPTION_KEY,
      defaultTriageModel: "google/gemma-4-31b-it",
    });
  });

  it("loads deployment model overrides without treating the API key as required", () => {
    expect(
      loadConfig({
        ...requiredEnvironment,
        OPENROUTER_API_KEY: "deployment-key",
        DEFAULT_TRIAGE_MODEL: "openai/gpt-5-mini",
      }),
    ).toMatchObject({
      openRouterApiKey: "deployment-key",
      defaultTriageModel: "openai/gpt-5-mini",
    });
  });

  it("rejects malformed encryption keys safely", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        API_KEY_ENCRYPTION_KEY: "not-a-key",
      }),
    ).toThrow(new ConfigurationError("API_KEY_ENCRYPTION_KEY is invalid"));
  });

  it("accepts an explicit prefix while validating optional values", () => {
    expect(
      loadConfig({
        ...requiredEnvironment,
        TEXT_COMMAND_PREFIX: ";",
        DATABASE_URL: ":memory:",
        LOG_LEVEL: "debug",
      }),
    ).toMatchObject({
      textCommandPrefix: ";",
      databaseUrl: ":memory:",
      logLevel: "debug",
    });
  });

  it("normalizes and deduplicates CSV bot operator user IDs", () => {
    expect(
      loadConfig({
        ...requiredEnvironment,
        BOT_OPERATOR_USER_IDS:
          " 223456789012345678,123456789012345678,223456789012345678 ",
      }).botOperatorUserIds,
    ).toEqual(["123456789012345678", "223456789012345678"]);
  });

  it("reports the invalid key without echoing its secret value", () => {
    const secret = "must-not-appear-in-errors";

    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        DISCORD_TOKEN: secret,
        DISCORD_CLIENT_ID: "not-a-snowflake",
      }),
    ).toThrow(new ConfigurationError("DISCORD_CLIENT_ID is invalid"));

    try {
      loadConfig({
        ...requiredEnvironment,
        DISCORD_TOKEN: secret,
        LOG_LEVEL: "verbose",
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }

    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        BOT_OPERATOR_USER_IDS: "123456789012345678,not-a-snowflake",
      }),
    ).toThrow(new ConfigurationError("BOT_OPERATOR_USER_IDS is invalid"));
  });
});
