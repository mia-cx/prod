import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { openDatabase } from "../src/database.js";
import { applyMigrations } from "../src/migrations.js";
import { tickets } from "../src/schema.js";
import type { ReporterHubAccessSnapshot } from "../src/reporter-hub-access.js";
import { createSqliteTicketStore, type TicketStore } from "../src/tickets.js";

const emptySnapshot: ReporterHubAccessSnapshot = {
  version: 1,
  overwriteExisted: false,
  permissions: {
    ViewChannel: "unset",
    ReadMessageHistory: "unset",
    SendMessagesInThreads: "unset",
    UseApplicationCommands: "unset",
    SendMessages: "unset",
    CreatePublicThreads: "unset",
    CreatePrivateThreads: "unset",
    ManageThreads: "unset",
  },
};

const createOpenTicket = async (
  store: TicketStore,
  id = "ticket-assignment",
) => {
  const ticket = await store.create({
    id,
    guildId: "guild-1",
    hubChannelId: "hub-1",
    reporterUserId: `reporter-${id}`,
    originatingAlias: "issue",
  });
  await store.recordProgress(
    ticket.id,
    "thread_created",
    {},
    { threadId: `thread-${id}` },
  );
  await store.recordProgress(
    ticket.id,
    "instructions_posted",
    {},
    { openingMessageId: `message-${id}` },
  );
  await store.markOpen(ticket.id);
  const opened = await store.get(ticket.id);
  if (opened === undefined) throw new Error("Opened ticket was not persisted");
  return opened;
};

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
        number: 1,
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

  it("assigns sequential ticket numbers independently within each guild", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);

    try {
      const create = (id: string, guildId: string) =>
        store.create({
          id,
          guildId,
          hubChannelId: `hub-${guildId}`,
          reporterUserId: `reporter-${id}`,
          originatingAlias: "issue",
        });

      await expect(create("ticket-a", "guild-1")).resolves.toMatchObject({
        number: 1,
      });
      await expect(create("ticket-b", "guild-1")).resolves.toMatchObject({
        number: 2,
      });
      await expect(create("ticket-c", "guild-2")).resolves.toMatchObject({
        number: 1,
      });
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
      await store.recordProgress(
        second.id,
        "thread_created",
        {},
        { threadId: "thread-failed" },
      );
      await store.markFailed(second.id, "controlled failure");
      expect(await store.hasOtherActiveTicket(first)).toBe(false);
      const otherHub = await store.create({
        id: "ticket-3",
        guildId: "guild-1",
        hubChannelId: "hub-2",
        reporterUserId: "reporter-1",
        originatingAlias: "debugshare",
      });
      expect(await store.hasOtherActiveTicket(first)).toBe(false);
      expect(await store.hasOtherActiveTicket(otherHub)).toBe(false);
      expect(await store.listProvisioning()).toEqual([first, otherHub]);
    } finally {
      connection.close();
    }
  });

  it("persists the first reporter hub-access snapshot until final release", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    try {
      const ticket = await store.create({
        id: "ticket-access",
        guildId: "guild-1",
        hubChannelId: "hub-1",
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      expect(await store.beginReporterAccess(ticket, emptySnapshot)).toEqual(
        emptySnapshot,
      );
      const laterSnapshot: ReporterHubAccessSnapshot = {
        ...emptySnapshot,
        overwriteExisted: true,
      };
      expect(await store.beginReporterAccess(ticket, laterSnapshot)).toEqual(
        emptySnapshot,
      );
      expect(await store.getReporterAccess(ticket)).toEqual(emptySnapshot);
      await store.finishReporterAccess(ticket);
      expect(await store.getReporterAccess(ticket)).toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("enforces persistent reporter and guild admission before inserting", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    let timestamp = Date.parse("2026-07-17T10:00:00.000Z");
    const options = {
      now: () => new Date(timestamp).toISOString(),
      maxActiveTicketsPerReporter: 5,
      maxTicketsPerReporterWindow: 3,
      reporterWindowMs: 60_000,
      maxProvisioningTicketsPerGuild: 8,
    };
    const store = createSqliteTicketStore(connection.database, options);
    const create = (id: string, reporterUserId = "reporter-1") =>
      store.create({
        id,
        guildId: "guild-1",
        hubChannelId: "hub-1",
        reporterUserId,
        originatingAlias: "issue",
      });
    try {
      await create("ticket-1");
      await create("ticket-2");
      await create("ticket-3");
      const recreated = createSqliteTicketStore(connection.database, options);
      await expect(
        recreated.create({
          id: "ticket-rate-limited",
          guildId: "guild-1",
          hubChannelId: "hub-1",
          reporterUserId: "reporter-1",
          originatingAlias: "issue",
        }),
      ).rejects.toMatchObject({
        name: "TicketAdmissionError",
        code: "rate_limited",
      });
      expect(await store.get("ticket-rate-limited")).toBeUndefined();

      await store.markFailed("ticket-1", "retryable failure");
      await expect(create("ticket-still-rate-limited")).rejects.toMatchObject({
        code: "rate_limited",
      });
      const retryable = await create("ticket-retryable", "reporter-2");
      await store.markFailed(retryable.id, "retryable failure");
      await expect(create("ticket-retry", "reporter-2")).resolves.toMatchObject(
        {
          status: "provisioning",
        },
      );

      timestamp += 61_000;
      const activeLimited = createSqliteTicketStore(connection.database, {
        ...options,
        maxActiveTicketsPerReporter: 2,
        maxTicketsPerReporterWindow: 10,
      });
      await expect(
        activeLimited.create({
          id: "ticket-active-limited",
          guildId: "guild-1",
          hubChannelId: "hub-1",
          reporterUserId: "reporter-1",
          originatingAlias: "issue",
        }),
      ).rejects.toMatchObject({ code: "active_limit" });

      const guildLimited = createSqliteTicketStore(connection.database, {
        ...options,
        maxTicketsPerReporterWindow: 10,
        maxProvisioningTicketsPerGuild: 3,
      });
      await expect(
        guildLimited.create({
          id: "ticket-guild-limited",
          guildId: "guild-1",
          hubChannelId: "hub-1",
          reporterUserId: "reporter-2",
          originatingAlias: "issue",
        }),
      ).rejects.toMatchObject({ code: "guild_busy" });
    } finally {
      connection.close();
    }
  });

  it("adds and lists assignees with provenance while only the first add pauses triage", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    let timestamp = Date.parse("2026-07-22T10:00:00.000Z");
    const store = createSqliteTicketStore(connection.database, {
      now: () => new Date(timestamp++).toISOString(),
    });
    try {
      const ticket = await createOpenTicket(store);

      await expect(
        store.addAssignee({
          ticketId: ticket.id,
          assigneeUserId: "user-z",
          assignedByUserId: "user-z",
          method: "self_claim",
        }),
      ).resolves.toEqual({
        added: true,
        assigneeCount: 1,
        triagePaused: true,
      });
      await expect(store.get(ticket.id)).resolves.toMatchObject({
        triageStatus: "paused",
      });

      connection.database
        .update(tickets)
        .set({ triageStatus: "ready" })
        .where(eq(tickets.id, ticket.id))
        .run();
      await expect(
        store.addAssignee({
          ticketId: ticket.id,
          assigneeUserId: "user-a",
          assignedByUserId: "manager-1",
          method: "delegated",
        }),
      ).resolves.toEqual({
        added: true,
        assigneeCount: 2,
        triagePaused: false,
      });
      await expect(store.get(ticket.id)).resolves.toMatchObject({
        triageStatus: "ready",
      });

      expect(await store.listAssignees(ticket.id)).toEqual([
        {
          ticketId: ticket.id,
          assigneeUserId: "user-z",
          assignedByUserId: "user-z",
          method: "self_claim",
          createdAt: "2026-07-22T10:00:00.004Z",
        },
        {
          ticketId: ticket.id,
          assigneeUserId: "user-a",
          assignedByUserId: "manager-1",
          method: "delegated",
          createdAt: "2026-07-22T10:00:00.005Z",
        },
      ]);
      expect(
        (await store.listEvents(ticket.id))
          .filter(({ eventType }) => eventType === "assignee_added")
          .map(({ details }) => details),
      ).toEqual([
        {
          assigneeUserId: "user-z",
          assignedByUserId: "user-z",
          method: "self_claim",
          triagePaused: true,
        },
        {
          assigneeUserId: "user-a",
          assignedByUserId: "manager-1",
          method: "delegated",
          triagePaused: false,
        },
      ]);
    } finally {
      connection.close();
    }
  });

  it("treats a duplicate add as a no-op and preserves original provenance", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database, {
      now: () => "2026-07-22T10:00:00.000Z",
    });
    try {
      const ticket = await createOpenTicket(store);
      await store.addAssignee({
        ticketId: ticket.id,
        assigneeUserId: "user-1",
        assignedByUserId: "manager-original",
        method: "delegated",
      });

      await expect(
        store.addAssignee({
          ticketId: ticket.id,
          assigneeUserId: "user-1",
          assignedByUserId: "manager-later",
          method: "self_claim",
        }),
      ).resolves.toEqual({
        added: false,
        assigneeCount: 1,
        triagePaused: false,
      });
      expect(await store.listAssignees(ticket.id)).toEqual([
        {
          ticketId: ticket.id,
          assigneeUserId: "user-1",
          assignedByUserId: "manager-original",
          method: "delegated",
          createdAt: "2026-07-22T10:00:00.000Z",
        },
      ]);
      expect(
        (await store.listEvents(ticket.id)).filter(
          ({ eventType }) => eventType === "assignee_added",
        ),
      ).toHaveLength(1);
    } finally {
      connection.close();
    }
  });

  it("does not report another triage pause when the first current assignee is added to paused triage", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(store);
      await store.addAssignee({
        ticketId: ticket.id,
        assigneeUserId: "user-1",
        assignedByUserId: "user-1",
        method: "self_claim",
      });
      await store.removeAssignee({
        ticketId: ticket.id,
        assigneeUserId: "user-1",
        removedByUserId: "user-1",
      });

      await expect(
        store.addAssignee({
          ticketId: ticket.id,
          assigneeUserId: "user-2",
          assignedByUserId: "manager-1",
          method: "delegated",
        }),
      ).resolves.toEqual({
        added: true,
        assigneeCount: 1,
        triagePaused: false,
      });
      await expect(store.get(ticket.id)).resolves.toMatchObject({
        triageStatus: "paused",
      });
    } finally {
      connection.close();
    }
  });

  it("removes only the targeted assignee and leaves paused triage after the final removal", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(store);
      for (const assigneeUserId of ["user-1", "user-2"]) {
        await store.addAssignee({
          ticketId: ticket.id,
          assigneeUserId,
          assignedByUserId: "manager-1",
          method: "delegated",
        });
      }

      await expect(
        store.removeAssignee({
          ticketId: ticket.id,
          assigneeUserId: "user-1",
          removedByUserId: "manager-2",
        }),
      ).resolves.toEqual({ removed: true, assigneeCount: 1 });
      expect(await store.listAssignees(ticket.id)).toMatchObject([
        { assigneeUserId: "user-2" },
      ]);
      await expect(
        store.removeAssignee({
          ticketId: ticket.id,
          assigneeUserId: "user-2",
          removedByUserId: "manager-2",
        }),
      ).resolves.toEqual({ removed: true, assigneeCount: 0 });
      expect(await store.listAssignees(ticket.id)).toEqual([]);
      await expect(store.get(ticket.id)).resolves.toMatchObject({
        triageStatus: "paused",
      });
      expect(
        (await store.listEvents(ticket.id))
          .filter(({ eventType }) => eventType === "assignee_removed")
          .map(({ details }) => details),
      ).toEqual([
        { assigneeUserId: "user-1", removedByUserId: "manager-2" },
        { assigneeUserId: "user-2", removedByUserId: "manager-2" },
      ]);
    } finally {
      connection.close();
    }
  });

  it("treats removal of a non-assignee as a no-op without an event", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(store);
      await store.addAssignee({
        ticketId: ticket.id,
        assigneeUserId: "user-1",
        assignedByUserId: "user-1",
        method: "self_claim",
      });

      await expect(
        store.removeAssignee({
          ticketId: ticket.id,
          assigneeUserId: "user-missing",
          removedByUserId: "manager-1",
        }),
      ).resolves.toEqual({ removed: false, assigneeCount: 1 });
      expect(
        (await store.listEvents(ticket.id)).filter(
          ({ eventType }) => eventType === "assignee_removed",
        ),
      ).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("requires an open ticket for assignment changes", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    try {
      const ticket = await store.create({
        id: "ticket-provisioning",
        guildId: "guild-1",
        hubChannelId: "hub-1",
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      const add = (ticketId: string) =>
        store.addAssignee({
          ticketId,
          assigneeUserId: "user-1",
          assignedByUserId: "user-1",
          method: "self_claim",
        });
      const remove = (ticketId: string) =>
        store.removeAssignee({
          ticketId,
          assigneeUserId: "user-1",
          removedByUserId: "user-1",
        });

      await expect(add(ticket.id)).rejects.toThrow(
        "Ticket assignment needs an open ticket",
      );
      await expect(remove(ticket.id)).rejects.toThrow(
        "Ticket assignment needs an open ticket",
      );
      await expect(add("ticket-missing")).rejects.toThrow(
        "Ticket assignment needs an open ticket",
      );
      await expect(remove("ticket-missing")).rejects.toThrow(
        "Ticket assignment needs an open ticket",
      );
    } finally {
      connection.close();
    }
  });

  it("looks up tickets by their unique thread id", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(store, "ticket-thread-lookup");

      await expect(
        store.getByThreadId("thread-ticket-thread-lookup"),
      ).resolves.toEqual(ticket);
      await expect(
        store.getByThreadId("thread-missing"),
      ).resolves.toBeUndefined();
    } finally {
      connection.close();
    }
  });
});
