import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { openDatabase, type DatabaseConnection } from "../src/database.js";
import {
  DEFAULT_LABELS,
  DuplicateLabelNameError,
  LabelLimitError,
  LabelNotFoundError,
  MAX_LABELS,
  createSqliteLabelTaxonomyStore,
  normalizeLabelName,
} from "../src/label-taxonomy.js";
import { applyMigrations } from "../src/migrations.js";
import { tickets } from "../src/schema.js";

const connections: DatabaseConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

const setup = async () => {
  const connection = openDatabase(":memory:");
  connections.push(connection);
  await applyMigrations(connection.database);
  let id = 0;
  let tick = 0;
  const store = createSqliteLabelTaxonomyStore(connection.database, {
    createId: () => `label-${String(++id)}`,
    now: () => `2026-07-17T12:00:${String(tick++).padStart(2, "0")}.000Z`,
  });
  return { connection, store };
};

const insertTicket = async (
  connection: DatabaseConnection,
  id: string,
  guildId: string,
) =>
  connection.database.insert(tickets).values({
    id,
    number: 1,
    guildId,
    hubChannelId: `hub-${guildId}`,
    reporterUserId: "reporter-1",
    originatingAlias: "issue",
    status: "open",
    triageStatus: "collecting",
    createdAt: "2026-07-17T12:00:00.000Z",
    updatedAt: "2026-07-17T12:00:00.000Z",
  });

describe("SQLite guild label taxonomy", () => {
  it("normalizes Unicode, case, and whitespace consistently", () => {
    expect(normalizeLabelName("  ＢＵＧ\n report  ")).toBe("bug report");
  });

  it("seeds the five described generic labels exactly once", async () => {
    const { connection, store } = await setup();

    await Promise.all([
      store.ensureDefaults("guild-1"),
      store.ensureDefaults("guild-1"),
    ]);
    const labels = await store.list("guild-1");

    expect(labels.map(({ name }) => name).sort()).toEqual(
      DEFAULT_LABELS.map(({ name }) => name).sort(),
    );
    expect(
      labels.every(
        ({ description }) =>
          description !== undefined && description.length > 0,
      ),
    ).toBe(true);
    const restarted = createSqliteLabelTaxonomyStore(connection.database);
    await restarted.ensureDefaults("guild-1");
    await expect(
      restarted.list("guild-1"),
    ).resolves.toHaveLength(5);
  });

  it("does not recreate an editable default after it is renamed", async () => {
    const { connection, store } = await setup();
    await store.ensureDefaults("guild-1");
    const bug = (await store.findByName("guild-1", "bug"))!;

    await store.update("guild-1", bug.id, {
      name: "defect",
      description: "Unexpected behavior or broken functionality.",
    });
    await store.ensureDefaults("guild-1");

    await expect(store.list("guild-1")).resolves.toEqual([
      expect.objectContaining({ name: "account" }),
      expect.objectContaining({ id: bug.id, name: "defect" }),
      expect.objectContaining({ name: "feedback" }),
      expect.objectContaining({ name: "gameplay" }),
      expect.objectContaining({ name: "other" }),
    ]);
    await expect(store.findByName("guild-1", "bug")).resolves.toBeUndefined();

    const restarted = createSqliteLabelTaxonomyStore(connection.database);
    await restarted.ensureDefaults("guild-1");
    await expect(restarted.list("guild-1")).resolves.toHaveLength(5);
    await expect(
      restarted.findByName("guild-1", "defect"),
    ).resolves.toMatchObject({ id: bug.id });
  });

  it("makes first-write initialization an atomic store invariant", async () => {
    const { connection, store } = await setup();

    await Promise.all([
      store.create("guild-1", {
        name: "custom-a",
        description: "First concurrent custom label.",
      }),
      store.create("guild-1", {
        name: "custom-b",
        description: "Second concurrent custom label.",
      }),
    ]);
    await expect(store.list("guild-1")).resolves.toHaveLength(7);

    await expect(
      store.create("guild-2", {
        name: "bug",
        description: "Conflicts with a seeded default.",
      }),
    ).rejects.toBeInstanceOf(DuplicateLabelNameError);
    await expect(store.list("guild-2")).resolves.toHaveLength(5);

    for (
      let index = 0;
      index < MAX_LABELS - DEFAULT_LABELS.length;
      index++
    ) {
      await store.create("guild-3", {
        name: `custom-${String(index)}`,
        description: `Custom label ${String(index)}.`,
      });
    }
    await store.ensureDefaults("guild-3");
    const restarted = createSqliteLabelTaxonomyStore(connection.database);
    await restarted.ensureDefaults("guild-3");
    await expect(restarted.list("guild-3")).resolves.toHaveLength(
      MAX_LABELS,
    );
    await expect(
      restarted.create("guild-3", {
        name: "overflow",
        description: "This must not exceed the label bound.",
      }),
    ).rejects.toBeInstanceOf(LabelLimitError);
  });

  it("creates and edits labels while enforcing normalized guild uniqueness", async () => {
    const { store } = await setup();
    await store.ensureDefaults("guild-1");
    await store.ensureDefaults("guild-2");
    const created = await store.create("guild-1", {
      name: "  Connection   Issue ",
      description: "  Trouble connecting to a server.  ",
    });

    expect(created).toMatchObject({
      name: "Connection Issue",
      normalizedName: "connection issue",
      description: "Trouble connecting to a server.",
    });
    const undescribed = await store.create("guild-1", {
      name: "needs review",
    });
    expect(undescribed).not.toHaveProperty("description");
    await expect(
      store.update("guild-1", undescribed.id, {
        name: "reviewed",
        description: "   ",
      }),
    ).resolves.not.toHaveProperty("description");
    await expect(
      store.create("guild-1", {
        name: "ＣＯＮＮＥＣＴＩＯＮ issue",
        description: "Duplicate.",
      }),
    ).rejects.toBeInstanceOf(DuplicateLabelNameError);
    await expect(
      store.create("guild-2", {
        name: "connection issue",
        description: "Allowed in another guild.",
      }),
    ).resolves.toMatchObject({ guildId: "guild-2" });

    const updated = await store.update("guild-1", created.id, {
      name: "Connectivity",
      description: "Network and server connectivity problems.",
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: "Connectivity",
      normalizedName: "connectivity",
      description: "Network and server connectivity problems.",
    });
  });

  it("deletes a label and cascades only its ticket associations", async () => {
    const { connection, store } = await setup();
    await store.ensureDefaults("guild-1");
    await insertTicket(connection, "ticket-1", "guild-1");
    const bug = (await store.findByName("guild-1", "bug"))!;
    const account = (await store.findByName("guild-1", "account"))!;
    for (const label of [bug, account]) {
      await store.selectForTicket({
        guildId: "guild-1",
        ticketId: "ticket-1",
        labelId: label.id,
        actor: { type: "user", id: "staff-1" },
      });
    }

    await store.delete("guild-1", bug.id);

    await expect(store.findById("guild-1", bug.id)).resolves.toBeUndefined();
    await expect(store.listForTicket("ticket-1")).resolves.toEqual([
      expect.objectContaining({ id: account.id, name: "account" }),
    ]);
  });

  it("rejects nonexistent and cross-guild ticket associations", async () => {
    const { connection, store } = await setup();
    await store.ensureDefaults("guild-1");
    const bug = (await store.findByName("guild-1", "bug"))!;

    await expect(
      store.selectForTicket({
        guildId: "guild-1",
        ticketId: "missing-ticket",
        labelId: bug.id,
        actor: { type: "user", id: "staff-1" },
      }),
    ).rejects.toThrow("That ticket no longer exists in this guild.");

    await insertTicket(connection, "ticket-2", "guild-2");
    await expect(
      store.selectForTicket({
        guildId: "guild-1",
        ticketId: "ticket-2",
        labelId: bug.id,
        actor: { type: "user", id: "staff-1" },
      }),
    ).rejects.toThrow("That ticket no longer exists in this guild.");
  });

  it("rejects selection safely when concurrent deletion wins", async () => {
    const { connection, store } = await setup();
    await store.ensureDefaults("guild-1");
    await insertTicket(connection, "ticket-2", "guild-1");
    const bug = (await store.findByName("guild-1", "bug"))!;

    const [deletion, selection] = await Promise.allSettled([
      store.delete("guild-1", bug.id),
      store.selectForTicket({
        guildId: "guild-1",
        ticketId: "ticket-2",
        labelId: bug.id,
        actor: { type: "service", id: "prod-ai" },
      }),
    ]);

    expect(deletion.status).toBe("fulfilled");
    expect(selection).toMatchObject({
      status: "rejected",
      reason: expect.any(LabelNotFoundError),
    });
    await expect(store.listForTicket("ticket-2")).resolves.toEqual([]);
  });

  it("cascades ticket deletion to its label associations", async () => {
    const { connection, store } = await setup();
    await store.ensureDefaults("guild-1");
    await insertTicket(connection, "ticket-1", "guild-1");
    const bug = (await store.findByName("guild-1", "bug"))!;
    await store.selectForTicket({
      guildId: "guild-1",
      ticketId: "ticket-1",
      labelId: bug.id,
      actor: { type: "user", id: "staff-1" },
    });

    await connection.database
      .delete(tickets)
      .where(eq(tickets.id, "ticket-1"));

    await expect(store.listForTicket("ticket-1")).resolves.toEqual([]);
  });

  it("bounds selectable labels and lets deletion free a slot", async () => {
    const { store } = await setup();
    await store.ensureDefaults("guild-1");
    for (
      let index = DEFAULT_LABELS.length;
      index < MAX_LABELS;
      index++
    ) {
      await store.create("guild-1", {
        name: `custom-${String(index)}`,
        description: `Custom label ${String(index)}.`,
      });
    }

    await expect(
      store.create("guild-1", {
        name: "overflow",
        description: "This label exceeds the select limit.",
      }),
    ).rejects.toBeInstanceOf(LabelLimitError);

    const removed = (await store.findByName("guild-1", "custom-5"))!;
    await store.delete("guild-1", removed.id);
    await expect(
      store.create("guild-1", {
        name: "replacement",
        description: "A replacement label.",
      }),
    ).resolves.toMatchObject({ name: "replacement" });
    await expect(store.list("guild-1")).resolves.toHaveLength(MAX_LABELS);
  });
});
