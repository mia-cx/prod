import type { Guild } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type DatabaseConnection } from "../src/database.js";
import { createSqliteGuildSettingsStore } from "../src/guild-settings.js";
import { createGuildSetupService } from "../src/guild-setup.js";
import type { HubPermissionOwnership } from "../src/hub-permission-ownership.js";
import { applyMigrations } from "../src/migrations.js";
import type { SupportHubDiscord } from "../src/support-hub.js";

const connections: DatabaseConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

const ownership = (channelId: string): HubPermissionOwnership => ({
  version: 1,
  channelId,
  botMemberId: "bot-1",
  everyone: {
    SendMessages: "unset",
    SendMessagesInThreads: "unset",
    CreatePublicThreads: "unset",
    CreatePrivateThreads: "unset",
  },
  bot: {
    SendMessages: "unset",
    SendMessagesInThreads: "unset",
    CreatePublicThreads: "unset",
    CreatePrivateThreads: "unset",
  },
});

const setup = async () => {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  await applyMigrations(connection.database);
  const store = createSqliteGuildSettingsStore(connection.database);
  const discord: SupportHubDiscord = {
    validateHub: vi.fn(async () => ({ valid: true as const })),
    configureHub: vi.fn(async (_guild, channelId, existing) => ({
      valid: true as const,
      permissionOwnership: existing ?? ownership(channelId),
    })),
    restoreHub: vi.fn(async () => undefined),
    releaseHub: vi.fn(async () => undefined),
    upsertInformationMessage: vi.fn(async () => "message-1"),
    deleteInformationMessage: vi.fn(async () => undefined),
  };
  return {
    store,
    discord,
    service: createGuildSetupService(store, discord),
    guild: { id: "guild-1" } as Guild,
  };
};

describe("guild setup lifecycle", () => {
  it("releases the former hub before committing ownership of its replacement", async () => {
    const { store, discord, service, guild } = await setup();
    await service.configureHub(guild, "hub-a");
    await store.setHubInformationMessage(guild.id, "message-a");

    await service.configureHub(guild, "hub-b");

    expect(discord.deleteInformationMessage).toHaveBeenCalledWith(
      guild,
      "hub-a",
      "message-a",
    );
    expect(discord.releaseHub).toHaveBeenCalledWith(guild, ownership("hub-a"));
    await expect(store.get(guild.id)).resolves.toMatchObject({
      hubChannelId: "hub-b",
      hubPermissionOwnership: ownership("hub-b"),
    });
    expect((await store.get(guild.id)).hubInformationMessageId).toBeUndefined();
  });

  it("rolls back the replacement and restores the former hub when cleanup fails", async () => {
    const { store, discord, service, guild } = await setup();
    await service.configureHub(guild, "hub-a");
    vi.mocked(discord.releaseHub).mockImplementation(async (_guild, owned) => {
      if (owned.channelId === "hub-a") throw new Error("cleanup failed");
    });

    await expect(service.configureHub(guild, "hub-b")).rejects.toThrow(
      "cleanup failed",
    );

    expect(discord.releaseHub).toHaveBeenCalledWith(guild, ownership("hub-b"));
    expect(discord.restoreHub).toHaveBeenCalledWith(guild, ownership("hub-a"));
    await expect(store.get(guild.id)).resolves.toMatchObject({
      hubChannelId: "hub-a",
      hubPermissionOwnership: ownership("hub-a"),
    });
  });

  it("serializes concurrent information refreshes and reuses the persisted message", async () => {
    const { discord, service, guild } = await setup();
    await service.configureHub(guild, "hub-a");
    let finishFirst: (messageId: string) => void = () => undefined;
    const firstResult = new Promise<string>((resolve) => {
      finishFirst = resolve;
    });
    vi.mocked(discord.upsertInformationMessage)
      .mockImplementationOnce(async () => firstResult)
      .mockResolvedValueOnce("message-1");

    const first = service.refreshInformationMessage(guild);
    const second = service.refreshInformationMessage(guild);
    await vi.waitFor(() => {
      expect(discord.upsertInformationMessage).toHaveBeenCalledOnce();
    });

    finishFirst("message-1");
    await expect(Promise.all([first, second])).resolves.toEqual([
      { valid: true },
      { valid: true },
    ]);
    expect(discord.upsertInformationMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ messageId: "message-1" }),
    );
  });
});
