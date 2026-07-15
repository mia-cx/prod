import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { MigrationConfig } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";

import type { ProdDatabase } from "./database.js";

export type MigrationRunner = (
  database: ProdDatabase,
  config: MigrationConfig,
) => Promise<void> | void;

export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export const applyMigrations = async (
  database: ProdDatabase,
  runMigrations: MigrationRunner = migrate,
  onHistoryApplied: (owner: "prod") => void = () => undefined,
): Promise<void> => {
  await runMigrations(database, { migrationsFolder });
  onHistoryApplied("prod");
};
