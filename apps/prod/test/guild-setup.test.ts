import type { Guild } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type DatabaseConnection } from "../src/database.js";
import { createSqliteGuildSettingsStore } from "../src/guild-settings.js";
import { createGuildSetupService } from "../src/guild-setup.js";
import type { HubPermissionOwnership } from "../src/hub-permission-ownership.js";
import type { HubTransition } from "../src/hub-transition.js";
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
    prepareHub: vi.fn(async (_guild, channelId, existing) => ({
      valid: true as const,
      permissionOwnership: existing ?? ownership(channelId),
    })),
    applyHub: vi.fn(async (_guild, permissionOwnership) => ({
      valid: true as const,
      permissionOwnership,
    })),
    restoreHub: vi.fn(async () => undefined),
    releaseHub: vi.fn(async () => undefined),
    upsertInformationMessage: vi.fn(
      async (input) => input.messageId ?? "message-1",
    ),
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
  it("persists permission ownership before applying Discord changes", async () => {
    const { store, discord, service, guild } = await setup();
    vi.mocked(discord.applyHub).mockImplementation(
      async (_guild, permissionOwnership) => {
        await expect(store.getHubTransition(guild.id)).resolves.toMatchObject({
          next: permissionOwnership,
        });
        return { valid: true as const, permissionOwnership };
      },
    );

    await service.configureHub(guild, "hub-a");

    await expect(store.getHubTransition(guild.id)).resolves.toBeUndefined();
  });

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
    await store.setHubInformationMessage(guild.id, "message-a");
    vi.mocked(discord.releaseHub).mockImplementation(async (_guild, owned) => {
      if (owned.channelId === "hub-a") throw new Error("cleanup failed");
    });

    await expect(service.configureHub(guild, "hub-b")).rejects.toThrow(
      "cleanup failed",
    );

    expect(discord.releaseHub).toHaveBeenCalledWith(guild, ownership("hub-b"));
    expect(discord.restoreHub).toHaveBeenCalledWith(guild, ownership("hub-a"));
    expect(discord.upsertInformationMessage).toHaveBeenCalledWith({
      guild,
      channelId: "hub-a",
      assistantIdentity: "Prod",
      messageId: "message-a",
    });
    await expect(store.get(guild.id)).resolves.toMatchObject({
      hubChannelId: "hub-a",
      hubInformationMessageId: "message-a",
      hubPermissionOwnership: ownership("hub-a"),
    });
  });

  it("resumes a durable transition after Discord side effects and process reconstruction", async () => {
    const { store, discord, guild } = await setup();
    await store.configureHub(guild.id, "hub-a", ownership("hub-a"));
    await store.setHubInformationMessage(guild.id, "message-a");
    const transition: HubTransition = {
      version: 1,
      id: "transition-1",
      previous: {
        hubChannelId: "hub-a",
        hubInformationMessageId: "message-a",
        hubPermissionOwnership: ownership("hub-a"),
      },
      next: ownership("hub-b"),
    };
    await store.beginHubTransition(guild.id, transition);
    await discord.applyHub(guild, transition.next);
    await discord.deleteInformationMessage(guild, "hub-a", "message-a");
    await discord.releaseHub(guild, ownership("hub-a"));

    const restarted = createGuildSetupService(store, discord);
    await expect(restarted.get(guild)).resolves.toMatchObject({
      hubChannelId: "hub-b",
      hubPermissionOwnership: ownership("hub-b"),
    });

    expect(discord.applyHub).toHaveBeenCalledTimes(2);
    expect(discord.applyHub).toHaveBeenLastCalledWith(
      guild,
      ownership("hub-b"),
    );
    expect(discord.deleteInformationMessage).toHaveBeenCalledTimes(2);
    expect(discord.deleteInformationMessage).toHaveBeenLastCalledWith(
      guild,
      "hub-a",
      "message-a",
    );
    expect(discord.releaseHub).toHaveBeenCalledTimes(2);
    expect(discord.releaseHub).toHaveBeenLastCalledWith(
      guild,
      ownership("hub-a"),
    );
    await expect(store.getHubTransition(guild.id)).resolves.toBeUndefined();
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
