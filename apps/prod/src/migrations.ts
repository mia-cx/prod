import { authorizationMigrationManifest } from "@prod/authorization";
import { modelConfigMigrationManifest } from "@prod/model-config";

import type { ProdDatabase } from "./database.js";

export type Migration = Readonly<{
  id: string;
  apply: (database: ProdDatabase) => Promise<void> | void;
}>;

export type MigrationManifest = Readonly<{
  owner: string;
  migrations: readonly Migration[];
}>;

export const prodMigrationManifest: MigrationManifest = Object.freeze({
  owner: "prod",
  migrations: Object.freeze([]),
});

export const migrationManifests: readonly MigrationManifest[] = Object.freeze([
  authorizationMigrationManifest,
  modelConfigMigrationManifest,
  prodMigrationManifest,
]);

export const applyMigrations = async (
  database: ProdDatabase,
  manifests: readonly MigrationManifest[] = migrationManifests,
  onManifestApplied: (owner: string) => void = () => undefined,
): Promise<void> => {
  for (const manifest of manifests) {
    for (const migration of manifest.migrations) {
      await migration.apply(database);
    }
    onManifestApplied(manifest.owner);
  }
};

