import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import {
  applyMigrations,
  migrationManifests,
  type MigrationManifest,
} from "../src/migrations.js";

describe("migration composition", () => {
  it("owns package and application manifests in a fixed order", () => {
    expect(migrationManifests.map(({ owner }) => owner)).toEqual([
      "authorization",
      "model-config",
      "prod",
    ]);
  });

  it("applies each manifest and its migrations sequentially", async () => {
    const connection = openDatabase(":memory:");
    const applied: string[] = [];
    const manifests: readonly MigrationManifest[] = [
      {
        owner: "first",
        migrations: [
          {
            id: "001",
            apply: () => {
              applied.push("first:001");
            },
          },
        ],
      },
      {
        owner: "second",
        migrations: [
          {
            id: "001",
            apply: () => {
              applied.push("second:001");
            },
          },
        ],
      },
    ];

    try {
      await applyMigrations(connection.database, manifests, (owner) => applied.push(owner));
    } finally {
      connection.close();
    }

    expect(applied).toEqual(["first:001", "first", "second:001", "second"]);
  });
});
