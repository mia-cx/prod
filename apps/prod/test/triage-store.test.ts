import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type DatabaseConnection } from "../src/database.js";
import { applyMigrations } from "../src/migrations.js";
import {
  labels,
  processedReporterMessages,
  ticketAssignees,
  ticketAssigneeSuggestions,
  ticketEvents,
  ticketLabels,
  tickets,
  ticketTriageResults,
} from "../src/schema.js";
import { createSqliteTriageStore } from "../src/triage-store.js";

const completion = {
  internalSummary: "private context",
  reporterSummary: "thanks for the details",
  labelIds: ["label-1"],
  suggestedUserIds: ["staff-1", "staff-2"],
};
const timestamp = "2026-11-22T00:00:00.000Z";
const connections: DatabaseConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

const setup = async () => {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  const db = connection.database;
  await applyMigrations(db);
  db.insert(tickets)
    .values({
      id: "ticket-1",
      number: 1,
      guildId: "guild-1",
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
      status: "open",
      triageStatus: "collecting",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  db.insert(labels)
    .values({
      id: "label-1",
      guildId: "guild-1",
      name: "Bug",
      normalizedName: "bug",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return {
    db,
    store: createSqliteTriageStore(db),
    expected: { updatedAt: timestamp },
  };
};

describe("triage persistence", () => {
  it("claims a reporter message once, durably across store instances", async () => {
    const { db, store } = await setup();
    expect(await store.claimReporterMessage("ticket-1", "message-1")).toBe(
      true,
    );
    expect(
      await createSqliteTriageStore(db).claimReporterMessage(
        "ticket-1",
        "message-1",
      ),
    ).toBe(false);
    expect(await store.claimReporterMessage("ticket-1", "message-2")).toBe(
      true,
    );
    expect(db.select().from(processedReporterMessages).all()).toHaveLength(2);
    await expect(store.claimReporterMessage("ticket-1", "")).rejects.toThrow();
    await expect(
      store.claimReporterMessage("missing", "message-1"),
    ).rejects.toThrow();
  });

  it("completes with distinct summaries, service labels and suggestions, not assignments", async () => {
    const { db, store, expected } = await setup();
    expect(await store.isTriageEligible("ticket-1")).toBe(true);
    expect(
      await store.completeTriage("ticket-1", expected, {
        ...completion,
        labelIds: ["label-1", "label-1"],
        suggestedUserIds: ["staff-1", "staff-2", "staff-1"],
      }),
    ).toEqual({ discarded: false });
    expect(db.select().from(ticketTriageResults).get()).toMatchObject({
      internalSummary: completion.internalSummary,
      reporterSummary: completion.reporterSummary,
      completedAt: expect.any(String),
    });
    expect(db.select().from(ticketLabels).all()).toEqual([
      expect.objectContaining({
        labelId: "label-1",
        appliedByType: "service",
        appliedById: "prod-ai",
      }),
    ]);
    expect(db.select().from(ticketAssigneeSuggestions).all()).toEqual([
      expect.objectContaining({ userId: "staff-1", suggestedBy: "prod-ai" }),
      expect.objectContaining({ userId: "staff-2", suggestedBy: "prod-ai" }),
    ]);
    expect(db.select().from(ticketAssignees).all()).toEqual([]);
    expect(db.select().from(tickets).get()?.triageStatus).toBe("ready");
    expect(db.select().from(ticketEvents).get()?.eventType).toBe(
      "triage_completed",
    );
    expect(await store.isTriageEligible("ticket-1")).toBe(false);
    expect(
      await store.completeTriage("ticket-1", expected, completion),
    ).toEqual({ discarded: true });
  });

  it.each(["assigned", "paused", "closed", "ready", "changed", "missing"])(
    "discards a result after the ticket becomes %s",
    async (state) => {
      const { db, store, expected } = await setup();
      if (state === "assigned")
        db.insert(ticketAssignees)
          .values({
            ticketId: "ticket-1",
            assigneeUserId: "staff-1",
            assignedByUserId: "staff-1",
            method: "self_claim",
            createdAt: timestamp,
          })
          .run();
      if (state === "paused" || state === "ready")
        db.update(tickets).set({ triageStatus: state }).run();
      if (state === "closed")
        db.update(tickets).set({ status: "closed" }).run();
      if (state === "changed")
        db.update(tickets).set({ updatedAt: "later" }).run();
      if (state === "missing") db.delete(tickets).run();
      expect(
        await store.completeTriage("ticket-1", expected, completion),
      ).toEqual({ discarded: true });
      expect(await store.isTriageEligible("ticket-1")).toBe(
        state === "changed",
      );
      expect(db.select().from(ticketTriageResults).all()).toEqual([]);
      expect(db.select().from(ticketLabels).all()).toEqual([]);
      expect(db.select().from(ticketAssigneeSuggestions).all()).toEqual([]);
      expect(db.select().from(ticketEvents).all()).toEqual([]);
    },
  );

  it.each(["missing", "foreign"])(
    "rejects %s labels without partial completion",
    async (id) => {
      const { db, store, expected } = await setup();
      if (id === "foreign")
        db.insert(labels)
          .values({
            id,
            guildId: "guild-2",
            name: "Other",
            normalizedName: "other",
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .run();
      await expect(
        store.completeTriage("ticket-1", expected, {
          ...completion,
          labelIds: ["label-1", id],
        }),
      ).rejects.toThrow("That label no longer exists.");
      expect(db.select().from(ticketLabels).all()).toEqual([]);
      expect(db.select().from(ticketTriageResults).all()).toEqual([]);
      expect(await store.isTriageEligible("ticket-1")).toBe(true);
    },
  );

  it("allows no labels or suggestions and preserves existing label provenance", async () => {
    const { db, store, expected } = await setup();
    db.insert(ticketLabels)
      .values({
        ticketId: "ticket-1",
        labelId: "label-1",
        appliedByType: "user",
        appliedById: "moderator",
        createdAt: timestamp,
      })
      .run();
    await store.completeTriage("ticket-1", expected, {
      ...completion,
      suggestedUserIds: [],
    });
    expect(db.select().from(ticketLabels).get()?.appliedById).toBe("moderator");
    expect(db.select().from(ticketAssigneeSuggestions).all()).toEqual([]);
    const second = await setup();
    await expect(
      second.store.completeTriage("ticket-1", second.expected, {
        ...completion,
        labelIds: [],
        suggestedUserIds: [],
      }),
    ).resolves.toEqual({ discarded: false });
  });

  it("rolls back all changes if the audit event fails", async () => {
    const { db, expected } = await setup();
    const id = randomUUID();
    db.insert(ticketEvents)
      .values({
        id,
        ticketId: "ticket-1",
        guildId: "guild-1",
        eventType: "opened",
        detailsJson: "{}",
        createdAt: timestamp,
      })
      .run();
    await expect(
      createSqliteTriageStore(db, { createId: () => id }).completeTriage(
        "ticket-1",
        expected,
        completion,
      ),
    ).rejects.toThrow();
    expect(db.select().from(ticketTriageResults).all()).toEqual([]);
    expect(db.select().from(ticketLabels).all()).toEqual([]);
    expect(db.select().from(ticketAssigneeSuggestions).all()).toEqual([]);
    expect(db.select().from(tickets).get()?.triageStatus).toBe("collecting");
  });

  it("rejects empty summaries and empty suggestion ids atomically", async () => {
    const { db, store, expected } = await setup();
    for (const result of [
      { ...completion, internalSummary: " " },
      { ...completion, reporterSummary: "" },
      { ...completion, suggestedUserIds: [""] },
    ]) {
      await expect(
        store.completeTriage("ticket-1", expected, result),
      ).rejects.toThrow(TypeError);
      expect(db.select().from(ticketTriageResults).all()).toEqual([]);
      expect(db.select().from(ticketLabels).all()).toEqual([]);
    }
    expect(
      db.get<{ total: number }>(
        sql`select count(*) as total from ticket_events`,
      )?.total,
    ).toBe(0);
    expect(
      db.select().from(tickets).where(eq(tickets.id, "ticket-1")).get()
        ?.triageStatus,
    ).toBe("collecting");
  });
});
