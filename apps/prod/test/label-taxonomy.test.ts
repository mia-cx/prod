import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type DatabaseConnection } from "../src/database.js";
import {
  DEFAULT_LABELS,
  DuplicateLabelNameError,
  LabelInactiveError,
  LabelLimitError,
  MAX_ACTIVE_LABELS,
  createSqliteLabelTaxonomyStore,
  normalizeLabelName,
} from "../src/label-taxonomy.js";
import { applyMigrations } from "../src/migrations.js";

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
    const labels = await store.list("guild-1", { includeInactive: true });

    expect(labels.map(({ name }) => name).sort()).toEqual(
      DEFAULT_LABELS.map(({ name }) => name).sort(),
    );
    expect(labels.every(({ description }) => description.length > 0)).toBe(
      true,
    );
    const restarted = createSqliteLabelTaxonomyStore(connection.database);
    await restarted.ensureDefaults("guild-1");
    await expect(
      restarted.list("guild-1", { includeInactive: true }),
    ).resolves.toHaveLength(5);
  });

  it("does not recreate an editable default after it is renamed", async () => {
    const { connection, store } = await setup();
    await store.ensureDefaults("guild-1");
    const bug = (await store.findByName("guild-1", "bug"))!;

    await store.update("guild-1", "bug", {
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
      active: true,
    });
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

    const updated = await store.update("guild-1", "connection issue", {
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

  it("keeps ticket history when a selected label is deactivated", async () => {
    const { store } = await setup();
    const bug = await store.findByName("guild-1", "bug");
    expect(bug).toBeUndefined();
    await store.ensureDefaults("guild-1");
    const seededBug = await store.findByName("guild-1", "bug");
    expect(seededBug).toBeDefined();

    await Promise.all([
      store.selectForTicket({
        guildId: "guild-1",
        ticketId: "ticket-1",
        labelId: seededBug!.id,
        actor: { type: "user", id: "staff-1" },
      }),
      store.deactivate("guild-1", "bug"),
    ]);

    expect((await store.list("guild-1")).map(({ name }) => name)).not.toContain(
      "bug",
    );
    await expect(store.listForTicket("ticket-1")).resolves.toEqual([
      expect.objectContaining({
        id: seededBug!.id,
        name: "bug",
        active: false,
      }),
    ]);
  });

  it("rejects a concurrent selection safely when deactivation wins", async () => {
    const { store } = await setup();
    await store.ensureDefaults("guild-1");
    const bug = (await store.findByName("guild-1", "bug"))!;

    const [deactivation, selection] = await Promise.allSettled([
      store.deactivate("guild-1", "bug"),
      store.selectForTicket({
        guildId: "guild-1",
        ticketId: "ticket-2",
        labelId: bug.id,
        actor: { type: "service", id: "prod-ai" },
      }),
    ]);

    expect(deactivation.status).toBe("fulfilled");
    expect(selection).toMatchObject({
      status: "rejected",
      reason: expect.any(LabelInactiveError),
    });
    await expect(store.listForTicket("ticket-2")).resolves.toEqual([]);
  });

  it("bounds active choices while allowing inactive history to accumulate", async () => {
    const { store } = await setup();
    await store.ensureDefaults("guild-1");
    for (
      let index = DEFAULT_LABELS.length;
      index < MAX_ACTIVE_LABELS;
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
        description: "This label exceeds the active limit.",
      }),
    ).rejects.toBeInstanceOf(LabelLimitError);

    await store.deactivate("guild-1", "custom-5");
    await expect(
      store.create("guild-1", {
        name: "replacement",
        description: "A replacement active label.",
      }),
    ).resolves.toMatchObject({ active: true });
    await expect(store.list("guild-1")).resolves.toHaveLength(
      MAX_ACTIVE_LABELS,
    );
    await expect(
      store.update("guild-1", "custom-5", {
        name: "changed-history",
        description: "Historical metadata must remain stable.",
      }),
    ).rejects.toBeInstanceOf(LabelInactiveError);
  });
});
