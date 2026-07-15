export type AuthorizationPackageBoundary = Readonly<{
  name: "@prod/authorization";
}>;

export const authorizationBoundary: AuthorizationPackageBoundary = Object.freeze({
  name: "@prod/authorization",
});

export const authorizationMigrationManifest = Object.freeze({
  owner: "authorization" as const,
  migrations: Object.freeze([]),
});
