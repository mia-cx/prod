import { describe, expect, it, vi } from "vitest";

import { openDatabase } from "../src/database.js";
import {
  applyMigrations,
  migrationsFolder,
  type MigrationRunner,
} from "../src/migrations.js";

describe("application-owned migration history", () => {
  it("applies the checked-in Drizzle history as one application-owned stream", async () => {
    const connection = openDatabase(":memory:");
    const onHistoryApplied = vi.fn();

    try {
      await applyMigrations(connection.database, undefined, onHistoryApplied);
    } finally {
      connection.close();
    }

    expect(migrationsFolder).toMatch(/apps\/prod\/drizzle$/);
    expect(onHistoryApplied).toHaveBeenCalledOnce();
    expect(onHistoryApplied).toHaveBeenCalledWith("prod");
  });

  it("passes only the application's migration folder to the runner", async () => {
    const connection = openDatabase(":memory:");
    const runMigrations: MigrationRunner = vi.fn();

    try {
      await applyMigrations(connection.database, runMigrations);
    } finally {
      connection.close();
    }

    expect(runMigrations).toHaveBeenCalledOnce();
    expect(runMigrations).toHaveBeenCalledWith(connection.database, {
      migrationsFolder,
    });
  });
});
