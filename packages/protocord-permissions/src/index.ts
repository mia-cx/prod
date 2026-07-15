export type PermissionsPackageBoundary = Readonly<{
  name: "@protocord/permissions";
}>;

export const permissionsBoundary: PermissionsPackageBoundary = Object.freeze({
  name: "@protocord/permissions",
});

export const permissionsMigrationManifest = Object.freeze({
  owner: "permissions" as const,
  migrations: Object.freeze([]),
});
