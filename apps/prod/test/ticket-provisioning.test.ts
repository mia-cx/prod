import { ChannelType, Collection, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { openDatabase } from "../src/database.js";
import type { GuildSettingsStore } from "../src/guild-settings.js";
import { applyMigrations } from "../src/migrations.js";
import {
  createTicketProvisioningDiscord,
  createTicketProvisioningService,
  REPORTER_TICKET_HUB_OVERWRITE,
  sanitizeTicketSummary,
  ticketOpeningInstructions,
  type TicketProvisioningDiscord,
} from "../src/ticket-provisioning.js";
import { createSqliteTicketStore } from "../src/tickets.js";

const guild = { id: "guild-1" } as Guild;
const settings = {
  get: async (guildId: string) => ({
    guildId,
    initialized: true,
    hubChannelId: "hub-1",
    assistantIdentity: "Prod",
    tone: "friendly",
  }),
} as GuildSettingsStore;

const discordFixture = (
  overrides: Partial<TicketProvisioningDiscord> = {},
): TicketProvisioningDiscord => ({
  validateReporter: vi.fn().mockResolvedValue(undefined),
  grantReporterAccess: vi.fn().mockResolvedValue(undefined),
  revokeReporterAccess: vi.fn().mockResolvedValue(undefined),
  findTicketThread: vi.fn().mockResolvedValue(undefined),
  createTicketThread: vi.fn().mockResolvedValue("thread-1"),
  addReporter: vi.fn().mockResolvedValue(undefined),
  upsertOpeningInstructions: vi.fn().mockResolvedValue("message-1"),
  deleteTicketThread: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe("ticket provisioning", () => {
  it("sanitizes the summary and opens only after every Discord resource succeeds", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => "ticket-12345678",
    });
    try {
      const ticket = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
        summary: "  **Crash**\u202e @everyone\nwhen clicking  ",
      });

      expect(ticket).toMatchObject({
        status: "open",
        threadId: "thread-1",
        openingMessageId: "message-1",
        summary: "\\*\\*Crash\\*\\* @\u200beveryone when clicking",
      });
      expect(discord.grantReporterAccess).toHaveBeenCalledBefore(
        vi.mocked(discord.createTicketThread),
      );
      expect(discord.addReporter).toHaveBeenCalledWith(
        guild,
        "thread-1",
        "reporter-1",
      );
      expect(ticketOpeningInstructions(ticket)).toContain("`DEBUGSHARE`");
      expect(ticketOpeningInstructions(ticket)).toContain(
        "ticket:ticket-12345678",
      );
      expect(
        (await store.listEvents(ticket.id)).map(({ eventType }) => eventType),
      ).toEqual([
        "provisioning_started",
        "reporter_access_granted",
        "thread_created",
        "reporter_added",
        "instructions_posted",
        "opened",
      ]);
    } finally {
      connection.close();
    }
  });

  it("compensates a partial failure without removing access needed by another ticket", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    let ticketNumber = 0;
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => `ticket-${++ticketNumber}`,
    });
    try {
      await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      vi.mocked(discord.createTicketThread).mockResolvedValueOnce("thread-2");
      vi.mocked(discord.addReporter).mockRejectedValueOnce(
        new Error("controlled Discord failure"),
      );

      await expect(
        service.open({
          guild,
          reporterUserId: "reporter-1",
          originatingAlias: "report",
        }),
      ).rejects.toMatchObject({ name: "TicketProvisioningError" });

      expect(discord.deleteTicketThread).toHaveBeenCalledWith(
        guild,
        "thread-2",
      );
      expect(discord.revokeReporterAccess).not.toHaveBeenCalled();
      const failed = await store.get("ticket-2");
      expect(failed).toMatchObject({
        status: "failed",
        failureReason: "controlled Discord failure",
      });
      expect((await store.listEvents("ticket-2")).at(-1)?.eventType).toBe(
        "compensation_completed",
      );
    } finally {
      connection.close();
    }
  });

  it("compensates Discord access when the following database audit write fails", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture();
    const failingStore = {
      ...store,
      recordProgress: vi
        .fn(store.recordProgress)
        .mockRejectedValueOnce(new Error("controlled database failure")),
    };
    const service = createTicketProvisioningService(
      settings,
      failingStore,
      discord,
      { createId: () => "ticket-db-failure" },
    );
    try {
      await expect(
        service.open({
          guild,
          reporterUserId: "reporter-1",
          originatingAlias: "issue",
        }),
      ).rejects.toMatchObject({ name: "TicketProvisioningError" });

      expect(discord.grantReporterAccess).toHaveBeenCalledOnce();
      expect(discord.createTicketThread).not.toHaveBeenCalled();
      expect(discord.revokeReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-1",
        "reporter-1",
      );
      expect(await store.get("ticket-db-failure")).toMatchObject({
        status: "failed",
        failureReason: "controlled database failure",
      });
      expect(
        (await store.listEvents("ticket-db-failure")).map(
          ({ eventType }) => eventType,
        ),
      ).toEqual([
        "provisioning_started",
        "provisioning_failed",
        "compensation_completed",
      ]);
    } finally {
      connection.close();
    }
  });

  it("recovers a known thread idempotently without creating another thread", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const ticket = await store.create({
      id: "ticket-stale",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "debugshare",
    });
    await store.recordProgress(
      ticket.id,
      "thread_created",
      {},
      { threadId: "thread-existing" },
    );
    const discord = discordFixture({
      upsertOpeningInstructions: vi.fn().mockResolvedValue("message-existing"),
    });
    const service = createTicketProvisioningService(settings, store, discord);
    try {
      await expect(service.recover(async () => guild)).resolves.toEqual({
        recovered: 1,
        failed: 0,
      });
      await expect(service.recover(async () => guild)).resolves.toEqual({
        recovered: 0,
        failed: 0,
      });
      expect(discord.createTicketThread).not.toHaveBeenCalled();
      expect(discord.addReporter).toHaveBeenCalledOnce();
      expect(discord.upsertOpeningInstructions).toHaveBeenCalledOnce();
      expect(await store.get(ticket.id)).toMatchObject({
        status: "open",
        threadId: "thread-existing",
        openingMessageId: "message-existing",
      });
    } finally {
      connection.close();
    }
  });
});

describe("Discord ticket privacy adapter", () => {
  it("verifies that the reporter still belongs to the guild", async () => {
    const fetch = vi.fn().mockResolvedValue({ id: "reporter-1" });
    const mockGuild = { members: { fetch } } as unknown as Guild;

    await createTicketProvisioningDiscord().validateReporter(
      mockGuild,
      "reporter-1",
    );

    expect(fetch).toHaveBeenCalledWith("reporter-1");
  });

  it("grants only shared hub/thread capabilities and posts no hub content", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn();
    const mockGuild = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.GuildText,
          permissionOverwrites: { edit },
          send,
        }),
      },
    } as unknown as Guild;

    await createTicketProvisioningDiscord().grantReporterAccess(
      mockGuild,
      "hub-1",
      "reporter-1",
    );

    expect(edit).toHaveBeenCalledWith(
      "reporter-1",
      REPORTER_TICKET_HUB_OVERWRITE,
      expect.objectContaining({ reason: expect.any(String) }),
    );
    expect(REPORTER_TICKET_HUB_OVERWRITE).toEqual({
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessagesInThreads: true,
      UseApplicationCommands: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("creates an invite-only private thread without a hub starter message", async () => {
    const create = vi.fn().mockResolvedValue({ id: "thread-1" });
    const send = vi.fn();
    const mockGuild = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.GuildText,
          threads: { create },
          send,
        }),
      },
    } as unknown as Guild;

    await createTicketProvisioningDiscord().createTicketThread(mockGuild, {
      id: "12345678-abcd",
      guildId: "guild-1",
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
      status: "provisioning",
      triageStatus: "collecting",
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:00:00.000Z",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ticket-12345678",
        type: ChannelType.PrivateThread,
        invitable: false,
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("edits deterministic instructions found by marker instead of duplicating them", async () => {
    const edit = vi.fn().mockResolvedValue({ id: "message-existing" });
    const send = vi.fn();
    const messages = new Collection([
      [
        "message-existing",
        {
          id: "message-existing",
          content: "-# Managed by Prod · ticket:ticket-stale",
          edit,
        },
      ],
    ]);
    const mockGuild = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.PrivateThread,
          messages: { fetch: vi.fn().mockResolvedValue(messages) },
          send,
        }),
      },
    } as unknown as Guild;

    await expect(
      createTicketProvisioningDiscord().upsertOpeningInstructions(mockGuild, {
        id: "ticket-stale",
        guildId: "guild-1",
        hubChannelId: "hub-1",
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
        status: "provisioning",
        triageStatus: "collecting",
        threadId: "thread-existing",
        createdAt: "2026-07-17T10:00:00.000Z",
        updatedAt: "2026-07-17T10:00:00.000Z",
      }),
    ).resolves.toBe("message-existing");
    expect(edit).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("removes control characters, neutralizes mentions, and caps summaries", () => {
    const sanitized = sanitizeTicketSummary(
      `  hello\u0000 @here ${"x".repeat(300)} `,
    )!;
    expect(sanitized).toContain("@\u200bhere");
    expect(sanitized).not.toContain("\u0000");
    expect([...sanitized]).toHaveLength(201);
  });
});
