import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, max, ne } from "drizzle-orm";

import type { ProdDatabase } from "./database.js";
import {
  parseReporterHubAccessSnapshot,
  type ReporterHubAccessSnapshot,
} from "./reporter-hub-access.js";
import { reporterHubAccess, ticketEvents, tickets } from "./schema.js";

export type TicketAlias = "issue" | "report" | "debugshare";
export type TicketStatus = "provisioning" | "open" | "closed" | "failed";
export type TriageStatus = "collecting" | "ready" | "paused";
export type TicketEventType = (typeof ticketEvents.$inferInsert)["eventType"];

export type Ticket = Readonly<{
  id: string;
  number: number;
  guildId: string;
  hubChannelId: string;
  reporterUserId: string;
  originatingAlias: TicketAlias;
  status: TicketStatus;
  triageStatus: TriageStatus;
  summary?: string;
  threadId?: string;
  openingMessageId?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type TicketEvent = Readonly<{
  sequence: number;
  id: string;
  ticketId: string;
  guildId: string;
  eventType: TicketEventType;
  details: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

export interface TicketStore {
  create(
    input: Readonly<{
      id: string;
      guildId: string;
      hubChannelId: string;
      reporterUserId: string;
      originatingAlias: TicketAlias;
      summary?: string;
    }>,
  ): Promise<Ticket>;
  get(ticketId: string): Promise<Ticket | undefined>;
  listProvisioning(): Promise<readonly Ticket[]>;
  listOpen(): Promise<readonly Ticket[]>;
  hasActiveTickets(guildId: string, hubChannelId: string): Promise<boolean>;
  listActiveThreadIds(
    guildId: string,
    hubChannelId: string,
  ): Promise<readonly string[]>;
  hasOtherActiveTicket(ticket: Ticket): Promise<boolean>;
  beginReporterAccess(
    ticket: Ticket,
    snapshot: ReporterHubAccessSnapshot,
  ): Promise<ReporterHubAccessSnapshot>;
  getReporterAccess(
    ticket: Ticket,
  ): Promise<ReporterHubAccessSnapshot | undefined>;
  finishReporterAccess(ticket: Ticket): Promise<void>;
  finishReporterAccessFor(
    guildId: string,
    hubChannelId: string,
    reporterUserId: string,
  ): Promise<void>;
  listReporterAccess(
    guildId: string,
    hubChannelId: string,
  ): Promise<
    readonly Readonly<{
      reporterUserId: string;
      snapshot: ReporterHubAccessSnapshot;
    }>[]
  >;
  listResumableReporterAccess(
    guildId: string,
    hubChannelId: string,
  ): Promise<
    readonly Readonly<{
      reporterUserId: string;
      snapshot: ReporterHubAccessSnapshot;
    }>[]
  >;
  recordProgress(
    ticketId: string,
    eventType: TicketEventType,
    details?: Readonly<Record<string, unknown>>,
    resources?: Readonly<{ threadId?: string; openingMessageId?: string }>,
  ): Promise<void>;
  markOpen(ticketId: string): Promise<void>;
  markFailed(ticketId: string, failureReason: string): Promise<void>;
  recordEvent(
    ticketId: string,
    eventType: TicketEventType,
    details?: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  listEvents(ticketId: string): Promise<readonly TicketEvent[]>;
}

export type CreateSqliteTicketStoreOptions = Readonly<{
  now?: () => string;
  createId?: () => string;
  maxActiveTicketsPerReporter?: number;
  maxTicketsPerReporterWindow?: number;
  reporterWindowMs?: number;
  maxProvisioningTicketsPerGuild?: number;
}>;

export class TicketAdmissionError extends Error {
  override readonly name = "TicketAdmissionError";
  readonly code: "active_limit" | "guild_busy" | "rate_limited";

  constructor(code: TicketAdmissionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export const DEFAULT_TICKET_ADMISSION = Object.freeze({
  maxActiveTicketsPerReporter: 5,
  maxTicketsPerReporterWindow: 3,
  reporterWindowMs: 60_000,
  maxProvisioningTicketsPerGuild: 8,
});

const assertId = (label: string, value: string): void => {
  if (value.trim().length === 0)
    throw new TypeError(`${label} must not be empty`);
};

const ticketFromRow = (row: typeof tickets.$inferSelect): Ticket =>
  Object.freeze({
    id: row.id,
    number: row.number,
    guildId: row.guildId,
    hubChannelId: row.hubChannelId,
    reporterUserId: row.reporterUserId,
    originatingAlias: row.originatingAlias,
    status: row.status,
    triageStatus: row.triageStatus,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.threadId === null ? {} : { threadId: row.threadId }),
    ...(row.openingMessageId === null
      ? {}
      : { openingMessageId: row.openingMessageId }),
    ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

export const createSqliteTicketStore = (
  database: ProdDatabase,
  options: CreateSqliteTicketStoreOptions = {},
): TicketStore => {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;
  const admission = {
    maxActiveTicketsPerReporter:
      options.maxActiveTicketsPerReporter ??
      DEFAULT_TICKET_ADMISSION.maxActiveTicketsPerReporter,
    maxTicketsPerReporterWindow:
      options.maxTicketsPerReporterWindow ??
      DEFAULT_TICKET_ADMISSION.maxTicketsPerReporterWindow,
    reporterWindowMs:
      options.reporterWindowMs ?? DEFAULT_TICKET_ADMISSION.reporterWindowMs,
    maxProvisioningTicketsPerGuild:
      options.maxProvisioningTicketsPerGuild ??
      DEFAULT_TICKET_ADMISSION.maxProvisioningTicketsPerGuild,
  };
  for (const [name, value] of Object.entries(admission)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  const insertEvent = (
    writer: Pick<ProdDatabase, "insert">,
    ticket: Pick<Ticket, "id" | "guildId">,
    eventType: TicketEventType,
    details: Readonly<Record<string, unknown>>,
    createdAt: string,
  ): void => {
    writer
      .insert(ticketEvents)
      .values({
        id: createId(),
        ticketId: ticket.id,
        guildId: ticket.guildId,
        eventType,
        detailsJson: JSON.stringify(details),
        createdAt,
      })
      .run();
  };
  const requireProvisioning = (
    writer: Pick<ProdDatabase, "select">,
    ticketId: string,
  ): typeof tickets.$inferSelect => {
    const row = writer
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .get();
    if (row === undefined) throw new Error(`Ticket ${ticketId} does not exist`);
    if (row.status !== "provisioning") {
      throw new Error(`Ticket ${ticketId} is not provisioning`);
    }
    return row;
  };

  return Object.freeze({
    create: async (
      input: Parameters<TicketStore["create"]>[0],
    ): Promise<Ticket> => {
      for (const [label, value] of [
        ["ticket id", input.id],
        ["guild id", input.guildId],
        ["hub channel id", input.hubChannelId],
        ["reporter user id", input.reporterUserId],
      ] as const) {
        assertId(label, value);
      }
      const timestamp = now();
      let row: typeof tickets.$inferSelect | undefined;
      database.transaction((transaction) => {
        const activeReporterTickets = transaction
          .select({ id: tickets.id })
          .from(tickets)
          .where(
            and(
              eq(tickets.guildId, input.guildId),
              eq(tickets.reporterUserId, input.reporterUserId),
              inArray(tickets.status, ["provisioning", "open"]),
            ),
          )
          .all().length;
        if (activeReporterTickets >= admission.maxActiveTicketsPerReporter) {
          throw new TicketAdmissionError(
            "active_limit",
            "You already have several active tickets. Please use an existing ticket or ask support staff for help.",
          );
        }
        const windowStart = new Date(
          new Date(timestamp).getTime() - admission.reporterWindowMs,
        ).toISOString();
        const recentReporterTickets = transaction
          .select({ id: tickets.id })
          .from(tickets)
          .where(
            and(
              eq(tickets.guildId, input.guildId),
              eq(tickets.reporterUserId, input.reporterUserId),
              gte(tickets.createdAt, windowStart),
            ),
          )
          .all().length;
        if (recentReporterTickets >= admission.maxTicketsPerReporterWindow) {
          throw new TicketAdmissionError(
            "rate_limited",
            "Please wait a minute before opening another private ticket.",
          );
        }
        const provisioningGuildTickets = transaction
          .select({ id: tickets.id })
          .from(tickets)
          .where(
            and(
              eq(tickets.guildId, input.guildId),
              eq(tickets.status, "provisioning"),
            ),
          )
          .all().length;
        if (
          provisioningGuildTickets >= admission.maxProvisioningTicketsPerGuild
        ) {
          throw new TicketAdmissionError(
            "guild_busy",
            "This server is opening several tickets right now. Please retry shortly.",
          );
        }
        const highestNumber = transaction
          .select({ value: max(tickets.number) })
          .from(tickets)
          .where(eq(tickets.guildId, input.guildId))
          .get()?.value;
        const newRow: typeof tickets.$inferSelect = {
          ...input,
          summary: input.summary ?? null,
          number: (highestNumber ?? 0) + 1,
          status: "provisioning",
          triageStatus: "collecting",
          threadId: null,
          openingMessageId: null,
          failureReason: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        transaction.insert(tickets).values(newRow).run();
        row = newRow;
        insertEvent(
          transaction,
          { id: input.id, guildId: input.guildId },
          "provisioning_started",
          { originatingAlias: input.originatingAlias },
          timestamp,
        );
      });
      if (row === undefined) throw new Error("Ticket transaction did not run");
      return ticketFromRow(row);
    },
    get: async (ticketId: string) => {
      assertId("ticket id", ticketId);
      const row = database
        .select()
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .get();
      return row === undefined ? undefined : ticketFromRow(row);
    },
    listProvisioning: async () =>
      database
        .select()
        .from(tickets)
        .where(eq(tickets.status, "provisioning"))
        .all()
        .map(ticketFromRow),
    listOpen: async () =>
      database
        .select()
        .from(tickets)
        .where(eq(tickets.status, "open"))
        .all()
        .map(ticketFromRow),
    hasActiveTickets: async (guildId: string, hubChannelId: string) =>
      database
        .select({ id: tickets.id })
        .from(tickets)
        .where(
          and(
            eq(tickets.guildId, guildId),
            eq(tickets.hubChannelId, hubChannelId),
            inArray(tickets.status, ["provisioning", "open"]),
          ),
        )
        .get() !== undefined,
    listActiveThreadIds: async (guildId: string, hubChannelId: string) =>
      database
        .select({ threadId: tickets.threadId })
        .from(tickets)
        .where(
          and(
            eq(tickets.guildId, guildId),
            eq(tickets.hubChannelId, hubChannelId),
            inArray(tickets.status, ["provisioning", "open"]),
            isNotNull(tickets.threadId),
          ),
        )
        .all()
        .flatMap(({ threadId }) => (threadId === null ? [] : [threadId])),
    hasOtherActiveTicket: async (ticket: Ticket) =>
      database
        .select({ id: tickets.id })
        .from(tickets)
        .where(
          and(
            eq(tickets.guildId, ticket.guildId),
            eq(tickets.hubChannelId, ticket.hubChannelId),
            eq(tickets.reporterUserId, ticket.reporterUserId),
            inArray(tickets.status, ["provisioning", "open"]),
            ne(tickets.id, ticket.id),
          ),
        )
        .get() !== undefined,
    beginReporterAccess: async (
      ticket: Ticket,
      snapshot: ReporterHubAccessSnapshot,
    ) => {
      const timestamp = now();
      database
        .insert(reporterHubAccess)
        .values({
          guildId: ticket.guildId,
          hubChannelId: ticket.hubChannelId,
          reporterUserId: ticket.reporterUserId,
          snapshotJson: JSON.stringify(snapshot),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing()
        .run();
      const stored = database
        .select({ snapshotJson: reporterHubAccess.snapshotJson })
        .from(reporterHubAccess)
        .where(
          and(
            eq(reporterHubAccess.guildId, ticket.guildId),
            eq(reporterHubAccess.hubChannelId, ticket.hubChannelId),
            eq(reporterHubAccess.reporterUserId, ticket.reporterUserId),
          ),
        )
        .get();
      if (stored === undefined) {
        throw new Error("Reporter hub access ownership was not persisted");
      }
      return parseReporterHubAccessSnapshot(stored.snapshotJson);
    },
    getReporterAccess: async (ticket: Ticket) => {
      const stored = database
        .select({ snapshotJson: reporterHubAccess.snapshotJson })
        .from(reporterHubAccess)
        .where(
          and(
            eq(reporterHubAccess.guildId, ticket.guildId),
            eq(reporterHubAccess.hubChannelId, ticket.hubChannelId),
            eq(reporterHubAccess.reporterUserId, ticket.reporterUserId),
          ),
        )
        .get();
      return stored === undefined
        ? undefined
        : parseReporterHubAccessSnapshot(stored.snapshotJson);
    },
    finishReporterAccess: async (ticket: Ticket) => {
      database
        .delete(reporterHubAccess)
        .where(
          and(
            eq(reporterHubAccess.guildId, ticket.guildId),
            eq(reporterHubAccess.hubChannelId, ticket.hubChannelId),
            eq(reporterHubAccess.reporterUserId, ticket.reporterUserId),
          ),
        )
        .run();
    },
    finishReporterAccessFor: async (
      guildId: string,
      hubChannelId: string,
      reporterUserId: string,
    ) => {
      database
        .delete(reporterHubAccess)
        .where(
          and(
            eq(reporterHubAccess.guildId, guildId),
            eq(reporterHubAccess.hubChannelId, hubChannelId),
            eq(reporterHubAccess.reporterUserId, reporterUserId),
          ),
        )
        .run();
    },
    listReporterAccess: async (guildId: string, hubChannelId: string) =>
      database
        .select({
          reporterUserId: reporterHubAccess.reporterUserId,
          snapshotJson: reporterHubAccess.snapshotJson,
        })
        .from(reporterHubAccess)
        .where(
          and(
            eq(reporterHubAccess.guildId, guildId),
            eq(reporterHubAccess.hubChannelId, hubChannelId),
          ),
        )
        .all()
        .map((row) =>
          Object.freeze({
            reporterUserId: row.reporterUserId,
            snapshot: parseReporterHubAccessSnapshot(row.snapshotJson),
          }),
        ),
    listResumableReporterAccess: async (
      guildId: string,
      hubChannelId: string,
    ) =>
      database
        .selectDistinct({
          reporterUserId: reporterHubAccess.reporterUserId,
          snapshotJson: reporterHubAccess.snapshotJson,
        })
        .from(reporterHubAccess)
        .innerJoin(
          tickets,
          and(
            eq(tickets.guildId, reporterHubAccess.guildId),
            eq(tickets.hubChannelId, reporterHubAccess.hubChannelId),
            eq(tickets.reporterUserId, reporterHubAccess.reporterUserId),
          ),
        )
        .where(
          and(
            eq(reporterHubAccess.guildId, guildId),
            eq(reporterHubAccess.hubChannelId, hubChannelId),
            inArray(tickets.status, ["provisioning", "open"]),
          ),
        )
        .all()
        .map((row) =>
          Object.freeze({
            reporterUserId: row.reporterUserId,
            snapshot: parseReporterHubAccessSnapshot(row.snapshotJson),
          }),
        ),
    recordProgress: async (
      ticketId: string,
      eventType: TicketEventType,
      details = {},
      resources = {},
    ) => {
      assertId("ticket id", ticketId);
      database.transaction((transaction) => {
        const row = requireProvisioning(transaction, ticketId);
        const timestamp = now();
        transaction
          .update(tickets)
          .set({ ...resources, updatedAt: timestamp })
          .where(eq(tickets.id, ticketId))
          .run();
        insertEvent(transaction, row, eventType, details, timestamp);
      });
    },
    markOpen: async (ticketId: string) => {
      assertId("ticket id", ticketId);
      database.transaction((transaction) => {
        const row = requireProvisioning(transaction, ticketId);
        if (row.threadId === null || row.openingMessageId === null) {
          throw new Error(
            "A ticket needs a thread and opening message before opening",
          );
        }
        const timestamp = now();
        transaction
          .update(tickets)
          .set({ status: "open", updatedAt: timestamp })
          .where(eq(tickets.id, ticketId))
          .run();
        insertEvent(transaction, row, "opened", {}, timestamp);
      });
    },
    markFailed: async (ticketId: string, failureReason: string) => {
      assertId("ticket id", ticketId);
      database.transaction((transaction) => {
        const row = requireProvisioning(transaction, ticketId);
        const timestamp = now();
        transaction
          .update(tickets)
          .set({ status: "failed", failureReason, updatedAt: timestamp })
          .where(eq(tickets.id, ticketId))
          .run();
        insertEvent(
          transaction,
          row,
          "provisioning_failed",
          { failureReason },
          timestamp,
        );
      });
    },
    recordEvent: async (
      ticketId: string,
      eventType: TicketEventType,
      details = {},
    ) => {
      assertId("ticket id", ticketId);
      database.transaction((transaction) => {
        const row = transaction
          .select({ id: tickets.id, guildId: tickets.guildId })
          .from(tickets)
          .where(eq(tickets.id, ticketId))
          .get();
        if (row === undefined)
          throw new Error(`Ticket ${ticketId} does not exist`);
        insertEvent(transaction, row, eventType, details, now());
      });
    },
    listEvents: async (ticketId: string) =>
      database
        .select()
        .from(ticketEvents)
        .where(eq(ticketEvents.ticketId, ticketId))
        .orderBy(ticketEvents.sequence)
        .all()
        .map((event) =>
          Object.freeze({
            sequence: event.sequence,
            id: event.id,
            ticketId: event.ticketId,
            guildId: event.guildId,
            eventType: event.eventType,
            details: JSON.parse(event.detailsJson) as Readonly<
              Record<string, unknown>
            >,
            createdAt: event.createdAt,
          }),
        ),
  });
};
