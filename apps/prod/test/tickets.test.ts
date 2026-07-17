import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { applyMigrations } from "../src/migrations.js";
import { createSqliteTicketStore } from "../src/tickets.js";

describe("SQLite ticket store", () => {
  it("persists provisioning resources and opens only after both exist", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    let id = 0;
    const store = createSqliteTicketStore(connection.database, {
      now: () => "2026-07-17T10:00:00.000Z",
      createId: () => `event-${++id}`,
    });

    try {
      const ticket = await store.create({
        id: "ticket-1",
        guildId: "guild-1",
        hubChannelId: "hub-1",
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
        summary: "Poke crashes",
      });
      expect(ticket).toMatchObject({
        status: "provisioning",
        triageStatus: "collecting",
      });
      await expect(store.markOpen(ticket.id)).rejects.toThrow(
        /thread and opening message/,
      );

      await store.recordProgress(
        ticket.id,
        "thread_created",
        {},
        { threadId: "thread-1" },
      );
      await store.recordProgress(
        ticket.id,
        "instructions_posted",
        {},
        { openingMessageId: "message-1" },
      );
      await store.markOpen(ticket.id);

      expect(await store.get(ticket.id)).toMatchObject({
        status: "open",
        threadId: "thread-1",
        openingMessageId: "message-1",
      });
      expect(
        (await store.listEvents(ticket.id)).map(({ eventType }) => eventType),
      ).toEqual([
        "provisioning_started",
        "thread_created",
        "instructions_posted",
        "opened",
      ]);
    } finally {
      connection.close();
    }
  });

  it("supports multiple active tickets and excludes the ticket being compensated", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    try {
      const first = await store.create({
        id: "ticket-1",
        guildId: "guild-1",
        hubChannelId: "hub-1",
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      expect(await store.hasOtherActiveTicket(first)).toBe(false);
      const second = await store.create({
        id: "ticket-2",
        guildId: "guild-1",
        hubChannelId: "hub-1",
        reporterUserId: "reporter-1",
        originatingAlias: "report",
      });
      expect(await store.hasOtherActiveTicket(first)).toBe(true);
      await store.markFailed(second.id, "controlled failure");
      expect(await store.hasOtherActiveTicket(first)).toBe(false);
      expect(await store.listProvisioning()).toEqual([first]);
    } finally {
      connection.close();
    }
  });
});
