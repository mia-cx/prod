import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import {
  createSqliteGuildSettingsStore,
  DEFAULT_ASSISTANT_IDENTITY,
  DEFAULT_ASSISTANT_TONE,
  GuildNotConfiguredError,
} from "../src/guild-settings.js";
import { applyMigrations } from "../src/migrations.js";

const createStore = async () => {
  const connection = openDatabase(":memory:");
  await applyMigrations(connection.database);
  let tick = 0;
  return {
    connection,
    store: createSqliteGuildSettingsStore(connection.database, {
      now: () => `2026-07-16T12:00:0${String(tick++)}.000Z`,
    }),
  };
};

describe("SQLite guild settings", () => {
  it("loads defaults without configuring or writing a guild", async () => {
    const { connection, store } = await createStore();
    try {
      await expect(store.get("guild-1")).resolves.toEqual({
        guildId: "guild-1",
        initialized: false,
        assistantIdentity: DEFAULT_ASSISTANT_IDENTITY,
        tone: DEFAULT_ASSISTANT_TONE,
      });
    } finally {
      connection.close();
    }
  });

  it("initializes defaults idempotently without replacing customization", async () => {
    const { connection, store } = await createStore();
    try {
      await store.initialize("guild-1");
      await store.setAssistantIdentity("guild-1", "Helper");
      await store.initialize("guild-1");

      await expect(store.get("guild-1")).resolves.toEqual({
        guildId: "guild-1",
        initialized: true,
        assistantIdentity: "Helper",
        tone: DEFAULT_ASSISTANT_TONE,
      });
    } finally {
      connection.close();
    }
  });

  it("persists the hub, message, identity, and tone across store instances", async () => {
    const { connection, store } = await createStore();
    try {
      await store.configureHub("guild-1", "channel-1");
      await store.setHubInformationMessage("guild-1", "message-1");
      await store.setAssistantIdentity("guild-1", "Support Guide");
      await store.setTone("guild-1", "Warm, direct, and brief");

      const restartedStore = createSqliteGuildSettingsStore(connection.database);
      await expect(restartedStore.get("guild-1")).resolves.toEqual({
        guildId: "guild-1",
        initialized: true,
        hubChannelId: "channel-1",
        hubInformationMessageId: "message-1",
        assistantIdentity: "Support Guide",
        tone: "Warm, direct, and brief",
      });
    } finally {
      connection.close();
    }
  });

  it("keeps a message on idempotent hub writes and clears it on hub changes", async () => {
    const { connection, store } = await createStore();
    try {
      await store.configureHub("guild-1", "channel-1");
      await store.setHubInformationMessage("guild-1", "message-1");
      await store.configureHub("guild-1", "channel-1");
      expect((await store.get("guild-1")).hubInformationMessageId).toBe(
        "message-1",
      );

      await store.configureHub("guild-1", "channel-2");
      expect(await store.get("guild-1")).toMatchObject({
        hubChannelId: "channel-2",
      });
      expect(
        (await store.get("guild-1")).hubInformationMessageId,
      ).toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("rejects information messages before a hub is configured", async () => {
    const { connection, store } = await createStore();
    try {
      await expect(
        store.setHubInformationMessage("guild-1", "message-1"),
      ).rejects.toBeInstanceOf(GuildNotConfiguredError);
    } finally {
      connection.close();
    }
  });
});
