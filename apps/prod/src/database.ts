import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ProdDatabase = ReturnType<typeof drizzle>;

export type DatabaseConnection = Readonly<{
  database: ProdDatabase;
  close: () => void;
}>;

const databasePathFromUrl = (databaseUrl: string): string => {
  if (databaseUrl === ":memory:") {
    return databaseUrl;
  }

  if (!databaseUrl.startsWith("file:")) {
    throw new Error("DATABASE_URL must be :memory: or a file: URL");
  }

  const path = databaseUrl.slice("file:".length);
  if (path.length === 0) {
    throw new Error("DATABASE_URL file path must not be empty");
  }

  return path;
};

export const openDatabase = (databaseUrl: string): DatabaseConnection => {
  const path = databasePathFromUrl(databaseUrl);
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");

  return Object.freeze({
    database: drizzle(sqlite),
    close: () => sqlite.close(),
  });
};
