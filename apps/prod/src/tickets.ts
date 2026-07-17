import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";

import type { ProdDatabase } from "./database.js";
import { ticketEvents, tickets } from "./schema.js";

export type TicketAlias = "issue" | "report" | "debugshare";
export type TicketStatus = "provisioning" | "open" | "closed" | "failed";
export type TriageStatus = "collecting" | "ready" | "paused";
export type TicketEventType = (typeof ticketEvents.$inferInsert)["eventType"];

export type Ticket = Readonly<{
  id: string;
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
  hasOtherActiveTicket(ticket: Ticket): Promise<boolean>;
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
}>;

const assertId = (label: string, value: string): void => {
  if (value.trim().length === 0)
    throw new TypeError(`${label} must not be empty`);
};

const ticketFromRow = (row: typeof tickets.$inferSelect): Ticket =>
  Object.freeze({
    id: row.id,
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
      const row: typeof tickets.$inferInsert = {
        ...input,
        status: "provisioning",
        triageStatus: "collecting",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.transaction((transaction) => {
        transaction.insert(tickets).values(row).run();
        insertEvent(
          transaction,
          { id: input.id, guildId: input.guildId },
          "provisioning_started",
          { originatingAlias: input.originatingAlias },
          timestamp,
        );
      });
      return ticketFromRow({
        ...row,
        summary: row.summary ?? null,
        threadId: null,
        openingMessageId: null,
        failureReason: null,
      });
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
    hasOtherActiveTicket: async (ticket: Ticket) =>
      database
        .select({ id: tickets.id })
        .from(tickets)
        .where(
          and(
            eq(tickets.guildId, ticket.guildId),
            eq(tickets.reporterUserId, ticket.reporterUserId),
            inArray(tickets.status, ["provisioning", "open"]),
            ne(tickets.id, ticket.id),
          ),
        )
        .get() !== undefined,
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
