import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import {
  InvalidModelConfigurationError,
  ModelCredentialError,
  type GuildModelConfiguration,
  type ModelConfigurationStore,
  type ModelPurpose,
  type SetGuildApiKeyInput,
  type SetModelInput,
} from "./contracts.js";
import {
  decodeEncryptionKey,
  decryptApiKey,
  encryptApiKey,
} from "./encryption.js";
import { modelConfigurations } from "./schema.js";

type ModelConfigurationRow = typeof modelConfigurations.$inferSelect;

export type CreateSqliteModelConfigurationStoreOptions = Readonly<{
  encryptionKey: string;
  defaultModelId: string;
  now?: () => string;
  createNonce?: () => Buffer;
}>;

export type ResolvedModelConfiguration = Readonly<{
  available: true;
  provider: "openrouter";
  modelId: string;
  apiKey: string;
  credentialSource: "guild" | "deployment";
}>;

export type UnavailableModelConfiguration = Readonly<{
  available: false;
  provider: "openrouter";
  modelId: string;
  reason: "missing-credential";
}>;

export interface SqliteModelConfigurationStore
  extends ModelConfigurationStore {
  resolve(
    guildId: string,
    purpose: ModelPurpose,
    deploymentApiKey?: string,
  ): Promise<ResolvedModelConfiguration | UnavailableModelConfiguration>;
}

const assertIdentifier = (label: string, value: string): void => {
  if (
    value.length === 0 ||
    value.length > 200 ||
    /\s/u.test(value) ||
    value.includes("://")
  ) {
    throw new InvalidModelConfigurationError(`${label} is invalid`);
  }
};

const credentialColumns = (row: ModelConfigurationRow) => {
  const values = [
    row.encryptedApiKey,
    row.apiKeyNonce,
    row.apiKeyAuthTag,
    row.apiKeyHint,
  ];
  const present = values.filter((value) => value !== null).length;
  if (present === 0) return undefined;
  if (present !== values.length) throw new ModelCredentialError();
  return {
    ciphertext: row.encryptedApiKey!,
    nonce: row.apiKeyNonce!,
    authTag: row.apiKeyAuthTag!,
    hint: row.apiKeyHint!,
  };
};

export const createSqliteModelConfigurationStore = (
  database: BetterSQLite3Database,
  options: CreateSqliteModelConfigurationStoreOptions,
): SqliteModelConfigurationStore => {
  assertIdentifier("defaultModelId", options.defaultModelId);
  const encryptionKey = decodeEncryptionKey(options.encryptionKey);
  const now = options.now ?? (() => new Date().toISOString());
  const find = (guildId: string, purpose: ModelPurpose) =>
    database
      .select()
      .from(modelConfigurations)
      .where(
        and(
          eq(modelConfigurations.guildId, guildId),
          eq(modelConfigurations.purpose, purpose),
        ),
      )
      .get();
  const ensure = (guildId: string, purpose: ModelPurpose): ModelConfigurationRow => {
    assertIdentifier("guildId", guildId);
    const existing = find(guildId, purpose);
    if (existing !== undefined) return existing;
    const timestamp = now();
    return database
      .insert(modelConfigurations)
      .values({
        guildId,
        purpose,
        provider: "openrouter",
        modelId: options.defaultModelId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  };
  const publicConfiguration = (
    row: ModelConfigurationRow,
  ): GuildModelConfiguration => {
    const encrypted = credentialColumns(row);
    return Object.freeze({
      guildId: row.guildId,
      purpose: row.purpose,
      provider: row.provider,
      modelId: row.modelId,
      ...(encrypted === undefined ? {} : { guildApiKeyHint: encrypted.hint }),
    });
  };

  return Object.freeze({
    get: async (guildId: string, purpose: ModelPurpose) =>
      publicConfiguration(ensure(guildId, purpose)),
    setModel: async (input: SetModelInput) => {
      assertIdentifier("guildId", input.guildId);
      assertIdentifier("modelId", input.modelId);
      ensure(input.guildId, input.purpose);
      database
        .update(modelConfigurations)
        .set({
          provider: input.provider,
          modelId: input.modelId,
          updatedAt: now(),
        })
        .where(
          and(
            eq(modelConfigurations.guildId, input.guildId),
            eq(modelConfigurations.purpose, input.purpose),
          ),
        )
        .run();
    },
    setGuildApiKey: async (input: SetGuildApiKeyInput) => {
      assertIdentifier("guildId", input.guildId);
      const encrypted = encryptApiKey(
        input.apiKey,
        encryptionKey,
        options.createNonce,
      );
      ensure(input.guildId, input.purpose);
      database
        .update(modelConfigurations)
        .set({
          encryptedApiKey: encrypted.ciphertext,
          apiKeyNonce: encrypted.nonce,
          apiKeyAuthTag: encrypted.authTag,
          apiKeyHint: encrypted.hint,
          updatedAt: now(),
        })
        .where(
          and(
            eq(modelConfigurations.guildId, input.guildId),
            eq(modelConfigurations.purpose, input.purpose),
          ),
        )
        .run();
    },
    clearGuildApiKey: async (guildId: string, purpose: ModelPurpose) => {
      assertIdentifier("guildId", guildId);
      ensure(guildId, purpose);
      database
        .update(modelConfigurations)
        .set({
          encryptedApiKey: null,
          apiKeyNonce: null,
          apiKeyAuthTag: null,
          apiKeyHint: null,
          updatedAt: now(),
        })
        .where(
          and(
            eq(modelConfigurations.guildId, guildId),
            eq(modelConfigurations.purpose, purpose),
          ),
        )
        .run();
    },
    resolve: async (
      guildId: string,
      purpose: ModelPurpose,
      deploymentApiKey?: string,
    ) => {
      const row = ensure(guildId, purpose);
      const encrypted = credentialColumns(row);
      if (encrypted !== undefined) {
        return Object.freeze({
          available: true as const,
          provider: row.provider,
          modelId: row.modelId,
          apiKey: decryptApiKey(encrypted, encryptionKey),
          credentialSource: "guild" as const,
        });
      }
      if (deploymentApiKey !== undefined && deploymentApiKey.length > 0) {
        return Object.freeze({
          available: true as const,
          provider: row.provider,
          modelId: row.modelId,
          apiKey: deploymentApiKey,
          credentialSource: "deployment" as const,
        });
      }
      return Object.freeze({
        available: false as const,
        provider: row.provider,
        modelId: row.modelId,
        reason: "missing-credential" as const,
      });
    },
  });
};
