import { randomBytes } from "node:crypto";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ModelCredentialError,
  createSqliteModelConfigurationStore,
} from "../src/index.js";

const encryptionKey = randomBytes(32).toString("base64");
const guildId = "123456789012345678";
const apiKey = "sk-or-v1-secret-value-1234";
const apiKeyHint = "sk-o••••••••••••••••••1234";

describe("SQLite model configuration store", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE mia_cx_model_configurations (
        guild_id text NOT NULL,
        purpose text NOT NULL,
        provider text NOT NULL,
        model_id text NOT NULL,
        encrypted_api_key text,
        api_key_hint text,
        api_key_nonce text,
        api_key_auth_tag text,
        api_key_envelope_version integer DEFAULT 0 NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (guild_id, purpose)
      )
    `);
  });

  afterEach(() => sqlite.close());

  const createStore = (key = encryptionKey) =>
    createSqliteModelConfigurationStore(drizzle(sqlite), {
      encryptionKey: key,
      defaultModelId: "anthropic/claude-sonnet-4",
    });

  it("persists model selection without exposing encrypted credential material", async () => {
    const store = createStore();
    await store.setModel({
      guildId,
      purpose: "triage",
      provider: "openrouter",
      modelId: "openai/gpt-5-mini",
    });

    await expect(store.get(guildId, "triage")).resolves.toEqual({
      guildId,
      purpose: "triage",
      provider: "openrouter",
      modelId: "openai/gpt-5-mini",
    });
  });

  it("uses a fresh nonce and stores ciphertext, tag, nonce, and a masked hint separately", async () => {
    const store = createStore();
    await store.setGuildApiKey({ guildId, purpose: "triage", apiKey });
    const first = sqlite
      .prepare("SELECT * FROM mia_cx_model_configurations")
      .get() as Record<string, string>;
    await store.setGuildApiKey({ guildId, purpose: "triage", apiKey });
    const second = sqlite
      .prepare("SELECT * FROM mia_cx_model_configurations")
      .get() as Record<string, string>;

    expect(first.api_key_nonce).not.toBe(second.api_key_nonce);
    expect(first.encrypted_api_key).not.toBe(second.encrypted_api_key);
    expect(first.api_key_auth_tag).toBeTruthy();
    expect(first.api_key_hint).toBe(apiKeyHint);
    expect(JSON.stringify(first)).not.toContain(apiKey);
    await expect(store.get(guildId, "triage")).resolves.toMatchObject({
      guildApiKeyHint: apiKeyHint,
    });
  });

  it("masks short keys entirely instead of revealing most characters", async () => {
    const store = createStore();
    const shortKey = "sk-abc123";
    await store.setGuildApiKey({ guildId, purpose: "triage", apiKey: shortKey });

    const { guildApiKeyHint } = await store.get(guildId, "triage");
    expect(guildApiKeyHint).toBe("••••••••");
  });

  it("prefers guild BYOK, then falls back to deployment credentials after clearing", async () => {
    const store = createStore();
    await store.setGuildApiKey({ guildId, purpose: "triage", apiKey });
    await expect(
      store.resolve(guildId, "triage", "deployment-secret"),
    ).resolves.toMatchObject({
      available: true,
      apiKey,
      credentialSource: "guild",
    });

    await store.clearGuildApiKey(guildId, "triage");
    await expect(
      store.resolve(guildId, "triage", "deployment-secret"),
    ).resolves.toMatchObject({
      available: true,
      apiKey: "deployment-secret",
      credentialSource: "deployment",
    });
    await expect(store.get(guildId, "triage")).resolves.not.toHaveProperty(
      "guildApiKeyHint",
    );
  });

  it("reports unavailable when neither credential source exists", async () => {
    await expect(
      createStore().resolve(guildId, "triage"),
    ).resolves.toMatchObject({
      available: false,
      reason: "missing-credential",
    });
  });

  it("fails safely for wrong encryption keys and malformed stored values", async () => {
    const store = createStore();
    await store.setGuildApiKey({ guildId, purpose: "triage", apiKey });

    await expect(
      createStore(randomBytes(32).toString("base64")).resolve(
        guildId,
        "triage",
      ),
    ).rejects.toThrow(ModelCredentialError);
    sqlite
      .prepare(
        "UPDATE mia_cx_model_configurations SET api_key_nonce = 'malformed'",
      )
      .run();
    await expect(store.resolve(guildId, "triage")).rejects.toThrow(
      ModelCredentialError,
    );
  });

  it("binds encrypted credentials to their guild and purpose row", async () => {
    const store = createStore();
    const otherGuildId = "223456789012345678";
    await store.setGuildApiKey({ guildId, purpose: "triage", apiKey });
    await store.get(otherGuildId, "triage");
    sqlite
      .prepare(`
        UPDATE mia_cx_model_configurations
        SET encrypted_api_key = source.encrypted_api_key,
            api_key_hint = source.api_key_hint,
            api_key_nonce = source.api_key_nonce,
            api_key_auth_tag = source.api_key_auth_tag,
            api_key_envelope_version = source.api_key_envelope_version
        FROM mia_cx_model_configurations AS source
        WHERE mia_cx_model_configurations.guild_id = ?
          AND source.guild_id = ?
      `)
      .run(otherGuildId, guildId);

    await expect(store.resolve(otherGuildId, "triage")).rejects.toThrow(
      ModelCredentialError,
    );
    await expect(store.resolve(guildId, "triage")).resolves.toMatchObject({
      available: true,
      apiKey,
    });
  });

  it("fails closed for pre-versioned credential envelopes", async () => {
    const store = createStore();
    await store.setGuildApiKey({ guildId, purpose: "triage", apiKey });
    sqlite
      .prepare(
        "UPDATE mia_cx_model_configurations SET api_key_envelope_version = 0",
      )
      .run();

    await expect(store.resolve(guildId, "triage")).rejects.toThrow(
      ModelCredentialError,
    );
    await store.clearGuildApiKey(guildId, "triage");
    await expect(
      store.resolve(guildId, "triage", "deployment-secret"),
    ).resolves.toMatchObject({
      available: true,
      credentialSource: "deployment",
    });
  });
});
