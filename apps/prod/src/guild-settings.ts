import { and, eq } from "drizzle-orm";

import type { ProdDatabase } from "./database.js";
import { guildSettings } from "./schema.js";

export const DEFAULT_ASSISTANT_IDENTITY = "Prod";
export const DEFAULT_ASSISTANT_TONE = "friendly, patient, and concise";

export type GuildSetupSettings = Readonly<{
  guildId: string;
  initialized: boolean;
  assistantIdentity: string;
  tone: string;
  hubChannelId?: string;
  hubInformationMessageId?: string;
}>;

export interface GuildSettingsStore {
  get(guildId: string): Promise<GuildSetupSettings>;
  initialize(guildId: string): Promise<void>;
  configureHub(guildId: string, channelId: string): Promise<void>;
  setHubInformationMessage(guildId: string, messageId: string): Promise<void>;
  setAssistantIdentity(guildId: string, identity: string): Promise<void>;
  setTone(guildId: string, tone: string): Promise<void>;
}

export class GuildNotConfiguredError extends Error {
  override readonly name = "GuildNotConfiguredError";
}

export type CreateSqliteGuildSettingsStoreOptions = Readonly<{
  now?: () => string;
}>;

type GuildSettingKey = (typeof guildSettings.$inferInsert)["key"];
type SettingsWriter = Pick<ProdDatabase, "delete" | "insert" | "select">;

const assertId = (label: string, value: string): void => {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
};

const insertDefaultRows = (
  writer: SettingsWriter,
  guildId: string,
  updatedAt: string,
): void => {
  writer
    .insert(guildSettings)
    .values([
      { guildId, key: "initialized", value: "1", updatedAt },
      {
        guildId,
        key: "assistant_identity",
        value: DEFAULT_ASSISTANT_IDENTITY,
        updatedAt,
      },
      {
        guildId,
        key: "tone",
        value: DEFAULT_ASSISTANT_TONE,
        updatedAt,
      },
    ])
    .onConflictDoNothing()
    .run();
};

const upsert = (
  writer: SettingsWriter,
  guildId: string,
  key: GuildSettingKey,
  value: string,
  updatedAt: string,
): void => {
  writer
    .insert(guildSettings)
    .values({ guildId, key, value, updatedAt })
    .onConflictDoUpdate({
      target: [guildSettings.guildId, guildSettings.key],
      set: { value, updatedAt },
    })
    .run();
};

export const createSqliteGuildSettingsStore = (
  database: ProdDatabase,
  options: CreateSqliteGuildSettingsStoreOptions = {},
): GuildSettingsStore => {
  const now = options.now ?? (() => new Date().toISOString());

  return Object.freeze({
    get: async (guildId: string): Promise<GuildSetupSettings> => {
      assertId("guildId", guildId);
      const values = new Map(
        database
          .select({ key: guildSettings.key, value: guildSettings.value })
          .from(guildSettings)
          .where(eq(guildSettings.guildId, guildId))
          .all()
          .map((row) => [row.key, row.value] as const),
      );
      const hubChannelId = values.get("hub_channel_id");
      const hubInformationMessageId = values.get("hub_information_message_id");
      return Object.freeze({
        guildId,
        initialized: values.get("initialized") === "1",
        assistantIdentity:
          values.get("assistant_identity") ?? DEFAULT_ASSISTANT_IDENTITY,
        tone: values.get("tone") ?? DEFAULT_ASSISTANT_TONE,
        ...(hubChannelId === undefined ? {} : { hubChannelId }),
        ...(hubInformationMessageId === undefined
          ? {}
          : { hubInformationMessageId }),
      });
    },
    initialize: async (guildId: string): Promise<void> => {
      assertId("guildId", guildId);
      database.transaction((transaction) => {
        insertDefaultRows(transaction, guildId, now());
      });
    },
    configureHub: async (guildId: string, channelId: string): Promise<void> => {
      assertId("guildId", guildId);
      assertId("channelId", channelId);
      database.transaction((transaction) => {
        const timestamp = now();
        insertDefaultRows(transaction, guildId, timestamp);
        const previous = transaction
          .select({ value: guildSettings.value })
          .from(guildSettings)
          .where(
            and(
              eq(guildSettings.guildId, guildId),
              eq(guildSettings.key, "hub_channel_id"),
            ),
          )
          .get();
        upsert(transaction, guildId, "hub_channel_id", channelId, timestamp);
        if (previous !== undefined && previous.value !== channelId) {
          transaction
            .delete(guildSettings)
            .where(
              and(
                eq(guildSettings.guildId, guildId),
                eq(guildSettings.key, "hub_information_message_id"),
              ),
            )
            .run();
        }
      });
    },
    setHubInformationMessage: async (
      guildId: string,
      messageId: string,
    ): Promise<void> => {
      assertId("guildId", guildId);
      assertId("messageId", messageId);
      database.transaction((transaction) => {
        const hub = transaction
          .select({ value: guildSettings.value })
          .from(guildSettings)
          .where(
            and(
              eq(guildSettings.guildId, guildId),
              eq(guildSettings.key, "hub_channel_id"),
            ),
          )
          .get();
        if (hub === undefined) {
          throw new GuildNotConfiguredError(
            "A support hub must be configured before storing its information message",
          );
        }
        upsert(
          transaction,
          guildId,
          "hub_information_message_id",
          messageId,
          now(),
        );
      });
    },
    setAssistantIdentity: async (
      guildId: string,
      identity: string,
    ): Promise<void> => {
      assertId("guildId", guildId);
      const normalized = identity.trim();
      assertId("identity", normalized);
      database.transaction((transaction) => {
        const timestamp = now();
        insertDefaultRows(transaction, guildId, timestamp);
        upsert(
          transaction,
          guildId,
          "assistant_identity",
          normalized,
          timestamp,
        );
      });
    },
    setTone: async (guildId: string, tone: string): Promise<void> => {
      assertId("guildId", guildId);
      const normalized = tone.trim();
      assertId("tone", normalized);
      database.transaction((transaction) => {
        const timestamp = now();
        insertDefaultRows(transaction, guildId, timestamp);
        upsert(transaction, guildId, "tone", normalized, timestamp);
      });
    },
  });
};
