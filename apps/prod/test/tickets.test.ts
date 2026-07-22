import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase, type ProdDatabase } from "../src/database.js";
import { applyMigrations } from "../src/migrations.js";
import type { ReporterHubAccessSnapshot } from "../src/reporter-hub-access.js";
import { labels, ticketLabels, tickets } from "../src/schema.js";
import {
  createSqliteTicketStore,
  TicketStateTransitionError,
  type Ticket,
  type TicketStatus,
  type TicketStore,
  type TriageStatus,
} from "../src/tickets.js";

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

type TicketFixtureState = `${TicketStatus}/${TriageStatus}`;

const createTicketInState = async (
  store: TicketStore,
  database: ProdDatabase,
  state: TicketFixtureState,
  id = "ticket-lifecycle",
): Promise<Ticket> => {
  const created = await store.create({
    id,
    guildId: "guild-lifecycle",
    hubChannelId: "hub-lifecycle",
    reporterUserId: `reporter-${id}`,
    originatingAlias: "issue",
    summary: "Preserve this summary",
  });
  if (state === "provisioning/collecting") return created;
  if (state === "failed/collecting") {
    await store.markFailed(id, "controlled failure");
    const failed = await store.get(id);
    if (failed === undefined) throw new Error("Expected failed ticket");
    return failed;
  }

  await store.recordProgress(
    id,
    "thread_created",
    {},
    { threadId: `thread-${id}` },
  );
  await store.recordProgress(
    id,
    "instructions_posted",
    {},
    { openingMessageId: `message-${id}` },
  );
  await store.markOpen(id);
  const [status, triageStatus] = state.split("/") as [
    TicketStatus,
    TriageStatus,
  ];
  database
    .update(tickets)
    .set({ status, triageStatus })
    .where(eq(tickets.id, id))
    .run();
  const ticket = await store.get(id);
  if (ticket === undefined) throw new Error("Expected lifecycle ticket");
  return ticket;
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

  it.each(["collecting", "ready", "paused"] as const)(
    "closes an open/%s ticket with details in its audit event",
    async (triageStatus) => {
      const connection = openDatabase(":memory:");
      await applyMigrations(connection.database);
      let timestamp = "2026-07-22T10:00:00.000Z";
      const store = createSqliteTicketStore(connection.database, {
        now: () => timestamp,
      });
      try {
        const ticket = await createTicketInState(
          store,
          connection.database,
          `open/${triageStatus}`,
        );
        const details = { actorUserId: "staff-1", reason: "Resolved" };
        timestamp = "2026-07-22T11:00:00.000Z";

        await expect(store.close(ticket.id, details)).resolves.toMatchObject({
          id: ticket.id,
          status: "closed",
          triageStatus: "paused",
          updatedAt: "2026-07-22T11:00:00.000Z",
        });
        await expect(store.get(ticket.id)).resolves.toMatchObject({
          status: "closed",
          triageStatus: "paused",
        });
        expect(
          (await store.listEvents(ticket.id)).filter(
            ({ eventType }) => eventType === "closed",
          ),
        ).toEqual([expect.objectContaining({ eventType: "closed", details })]);
      } finally {
        connection.close();
      }
    },
  );

  it.each([
    ["closed/paused", "closed", "paused"],
    ["provisioning/collecting", "provisioning", "collecting"],
    ["failed/collecting", "failed", "collecting"],
  ] as const)(
    "rejects closing a %s ticket without changing its row or events",
    async (state, status, triageStatus) => {
      const connection = openDatabase(":memory:");
      await applyMigrations(connection.database);
      const store = createSqliteTicketStore(connection.database);
      try {
        const ticket = await createTicketInState(
          store,
          connection.database,
          state,
        );
        const eventsBefore = await store.listEvents(ticket.id);

        await expect(store.close(ticket.id)).rejects.toMatchObject({
          name: "TicketStateTransitionError",
          transition: "close",
          status,
          triageStatus,
        });
        expect(await store.get(ticket.id)).toEqual(ticket);
        expect(await store.listEvents(ticket.id)).toEqual(eventsBefore);
      } finally {
        connection.close();
      }
    },
  );

  it("reopens a closed ticket paused without changing its related columns", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    let timestamp = "2026-07-22T10:00:00.000Z";
    const store = createSqliteTicketStore(connection.database, {
      now: () => timestamp,
    });
    try {
      const open = await createTicketInState(
        store,
        connection.database,
        "open/ready",
      );
      connection.database
        .insert(labels)
        .values({
          id: "label-lifecycle",
          guildId: open.guildId,
          name: "Lifecycle",
          normalizedName: "lifecycle",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      connection.database
        .insert(ticketLabels)
        .values({
          ticketId: open.id,
          labelId: "label-lifecycle",
          appliedByType: "user",
          appliedById: "staff-1",
          createdAt: timestamp,
        })
        .run();
      timestamp = "2026-07-22T11:00:00.000Z";
      const closed = await store.close(open.id);
      timestamp = "2026-07-22T12:00:00.000Z";

      const reopened = await store.reopen(closed.id, {
        actorUserId: "staff-2",
      });

      expect(reopened).toMatchObject({
        status: "open",
        triageStatus: "paused",
        summary: "Preserve this summary",
        threadId: "thread-ticket-lifecycle",
        openingMessageId: "message-ticket-lifecycle",
        updatedAt: "2026-07-22T12:00:00.000Z",
      });
      expect(reopened).toEqual({
        ...closed,
        status: "open",
        triageStatus: "paused",
        updatedAt: "2026-07-22T12:00:00.000Z",
      });
      expect(await store.get(closed.id)).toEqual(reopened);
      expect(
        connection.database
          .select()
          .from(ticketLabels)
          .where(eq(ticketLabels.ticketId, closed.id))
          .all(),
      ).toEqual([
        expect.objectContaining({
          ticketId: closed.id,
          labelId: "label-lifecycle",
          appliedById: "staff-1",
        }),
      ]);
      expect(await store.listEvents(closed.id)).toContainEqual(
        expect.objectContaining({
          eventType: "reopened",
          details: { actorUserId: "staff-2" },
        }),
      );
    } finally {
      connection.close();
    }
  });

  it.each([
    ["open/collecting", "open", "collecting"],
    ["provisioning/collecting", "provisioning", "collecting"],
    ["failed/collecting", "failed", "collecting"],
  ] as const)(
    "rejects reopening a %s ticket",
    async (state, status, triageStatus) => {
      const connection = openDatabase(":memory:");
      await applyMigrations(connection.database);
      const store = createSqliteTicketStore(connection.database);
      try {
        const ticket = await createTicketInState(
          store,
          connection.database,
          state,
        );
        const eventsBefore = await store.listEvents(ticket.id);

        await expect(store.reopen(ticket.id)).rejects.toMatchObject({
          name: "TicketStateTransitionError",
          transition: "reopen",
          status,
          triageStatus,
        });
        expect(await store.get(ticket.id)).toEqual(ticket);
        expect(await store.listEvents(ticket.id)).toEqual(eventsBefore);
      } finally {
        connection.close();
      }
    },
  );

  it("rolls back the ticket update when its audit event cannot be inserted", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    let id = 0;
    let collide = false;
    const store = createSqliteTicketStore(connection.database, {
      createId: () => (collide ? "event-1" : `event-${++id}`),
    });
    try {
      const ticket = await createTicketInState(
        store,
        connection.database,
        "open/collecting",
      );
      const eventsBefore = await store.listEvents(ticket.id);
      collide = true;

      await expect(store.close(ticket.id)).rejects.toMatchObject({
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
      expect(await store.get(ticket.id)).toEqual(ticket);
      expect(await store.listEvents(ticket.id)).toEqual(eventsBefore);
    } finally {
      connection.close();
    }
  });

  it("re-reads state after a concurrent transition loses its SQLite snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "prod-ticket-race-"));
    const databaseUrl = `file:${join(directory, "tickets.sqlite")}`;
    const connection = openDatabase(databaseUrl);
    await applyMigrations(connection.database);
    const otherConnection = openDatabase(databaseUrl);
    try {
      let competingClose: Promise<Ticket> | undefined;
      let race = false;
      let competingEvent = 0;
      const competingStore = createSqliteTicketStore(otherConnection.database, {
        createId: () => `competing-event-${++competingEvent}`,
      });
      let event = 0;
      const store = createSqliteTicketStore(connection.database, {
        now: () => {
          if (race && competingClose === undefined) {
            competingClose = competingStore.close("ticket-lifecycle");
          }
          return "2026-07-22T10:00:00.000Z";
        },
        createId: () => `primary-event-${++event}`,
      });
      const ticket = await createTicketInState(
        store,
        connection.database,
        "open/collecting",
      );
      race = true;

      await expect(store.close(ticket.id)).rejects.toMatchObject({
        name: "TicketStateTransitionError",
        status: "closed",
        triageStatus: "paused",
      });
      await expect(competingClose).resolves.toMatchObject({
        status: "closed",
        triageStatus: "paused",
      });
      expect(
        (await store.listEvents(ticket.id)).filter(
          ({ eventType }) => eventType === "closed",
        ),
      ).toHaveLength(1);
    } finally {
      connection.close();
      otherConnection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("pauses triage only from open/collecting and records details", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    let timestamp = "2026-07-22T10:00:00.000Z";
    const store = createSqliteTicketStore(connection.database, {
      now: () => timestamp,
    });
    try {
      const ticket = await createTicketInState(
        store,
        connection.database,
        "open/collecting",
      );
      timestamp = "2026-07-22T11:00:00.000Z";

      await expect(
        store.pauseTriage(ticket.id, { actorUserId: "staff-3" }),
      ).resolves.toMatchObject({
        status: "open",
        triageStatus: "paused",
        updatedAt: "2026-07-22T11:00:00.000Z",
      });
      expect(await store.listEvents(ticket.id)).toContainEqual(
        expect.objectContaining({
          eventType: "triage_paused",
          details: { actorUserId: "staff-3" },
        }),
      );
    } finally {
      connection.close();
    }
  });

  it.each([
    "open/ready",
    "open/paused",
    "closed/paused",
    "provisioning/collecting",
    "failed/collecting",
  ] as const)("rejects pausing triage from %s", async (state) => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createTicketInState(
        store,
        connection.database,
        state,
      );
      const eventsBefore = await store.listEvents(ticket.id);

      await expect(store.pauseTriage(ticket.id)).rejects.toBeInstanceOf(
        TicketStateTransitionError,
      );
      expect(await store.get(ticket.id)).toEqual(ticket);
      expect(await store.listEvents(ticket.id)).toEqual(eventsBefore);
    } finally {
      connection.close();
    }
  });

  it.each(["ready", "paused"] as const)(
    "resumes triage from open/%s and records details",
    async (triageStatus) => {
      const connection = openDatabase(":memory:");
      await applyMigrations(connection.database);
      let timestamp = "2026-07-22T10:00:00.000Z";
      const store = createSqliteTicketStore(connection.database, {
        now: () => timestamp,
      });
      try {
        const ticket = await createTicketInState(
          store,
          connection.database,
          `open/${triageStatus}`,
        );
        timestamp = "2026-07-22T11:00:00.000Z";

        await expect(
          store.resumeTriage(ticket.id, { actorUserId: "staff-4" }),
        ).resolves.toMatchObject({
          status: "open",
          triageStatus: "collecting",
          updatedAt: "2026-07-22T11:00:00.000Z",
        });
        expect(await store.listEvents(ticket.id)).toContainEqual(
          expect.objectContaining({
            eventType: "triage_resumed",
            details: { actorUserId: "staff-4" },
          }),
        );
      } finally {
        connection.close();
      }
    },
  );

  it.each([
    "open/collecting",
    "closed/paused",
    "provisioning/collecting",
    "failed/collecting",
  ] as const)("rejects resuming triage from %s", async (state) => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createTicketInState(
        store,
        connection.database,
        state,
      );
      const eventsBefore = await store.listEvents(ticket.id);

      await expect(store.resumeTriage(ticket.id)).rejects.toBeInstanceOf(
        TicketStateTransitionError,
      );
      expect(await store.get(ticket.id)).toEqual(ticket);
      expect(await store.listEvents(ticket.id)).toEqual(eventsBefore);
    } finally {
      connection.close();
    }
  });

  it("exposes current state and records exactly one event on duplicate close", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createTicketInState(
        store,
        connection.database,
        "open/collecting",
      );
      const closed = await store.close(ticket.id);

      await expect(store.close(ticket.id)).rejects.toMatchObject({
        name: "TicketStateTransitionError",
        ticketId: ticket.id,
        transition: "close",
        status: "closed",
        triageStatus: "paused",
      });
      expect(await store.get(ticket.id)).toEqual(closed);
      expect(
        (await store.listEvents(ticket.id)).filter(
          ({ eventType }) => eventType === "closed",
        ),
      ).toHaveLength(1);
    } finally {
      connection.close();
    }
  });
});
