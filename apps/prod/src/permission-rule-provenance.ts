import { and, asc, eq } from "drizzle-orm";
import type {
  PermissionVerb,
  RuleObject,
} from "@protocord/permissions";

import type { ProdDatabase } from "./database.js";
import { permissionRuleOrigins } from "./schema.js";

export type PermissionRuleIdentity = Readonly<{
  guildId: string;
  subject: Readonly<{
    subjectType: "user" | "role";
    subjectId: string;
  }>;
  object: RuleObject;
  verb: PermissionVerb;
}>;

export type PermissionRuleOrigin = Readonly<{
  sourceType: "preset" | "custom" | "independent";
  sourceId: string;
}>;

export interface PermissionRuleProvenanceStore {
  add(
    identity: PermissionRuleIdentity,
    origin: PermissionRuleOrigin,
  ): Promise<void>;
  remove(
    identity: PermissionRuleIdentity,
    origin: PermissionRuleOrigin,
  ): Promise<void>;
  removeAll(identity: PermissionRuleIdentity): Promise<void>;
  list(identity: PermissionRuleIdentity): Promise<readonly PermissionRuleOrigin[]>;
  listForSource(
    guildId: string,
    origin: PermissionRuleOrigin,
  ): Promise<readonly PermissionRuleIdentity[]>;
}

const identityConditions = (identity: PermissionRuleIdentity) => [
  eq(permissionRuleOrigins.guildId, identity.guildId),
  eq(permissionRuleOrigins.subjectType, identity.subject.subjectType),
  eq(permissionRuleOrigins.subjectId, identity.subject.subjectId),
  eq(permissionRuleOrigins.objectType, identity.object.objectType),
  eq(permissionRuleOrigins.objectId, identity.object.objectId),
  eq(permissionRuleOrigins.verb, identity.verb),
] as const;

const toRow = (
  identity: PermissionRuleIdentity,
  origin: PermissionRuleOrigin,
): typeof permissionRuleOrigins.$inferInsert => ({
  guildId: identity.guildId,
  subjectType: identity.subject.subjectType,
  subjectId: identity.subject.subjectId,
  objectType: identity.object.objectType,
  objectId: identity.object.objectId,
  verb: identity.verb,
  sourceType: origin.sourceType,
  sourceId: origin.sourceId,
});

const toIdentity = (
  row: typeof permissionRuleOrigins.$inferSelect,
): PermissionRuleIdentity => ({
  guildId: row.guildId,
  subject: { subjectType: row.subjectType, subjectId: row.subjectId },
  object: { objectType: row.objectType, objectId: row.objectId },
  verb: row.verb,
});

export const createSqlitePermissionRuleProvenanceStore = (
  database: ProdDatabase,
): PermissionRuleProvenanceStore =>
  Object.freeze({
    add: async (
      identity: PermissionRuleIdentity,
      origin: PermissionRuleOrigin,
    ) => {
      database
        .insert(permissionRuleOrigins)
        .values(toRow(identity, origin))
        .onConflictDoNothing()
        .run();
    },
    remove: async (
      identity: PermissionRuleIdentity,
      origin: PermissionRuleOrigin,
    ) => {
      database
        .delete(permissionRuleOrigins)
        .where(
          and(
            ...identityConditions(identity),
            eq(permissionRuleOrigins.sourceType, origin.sourceType),
            eq(permissionRuleOrigins.sourceId, origin.sourceId),
          ),
        )
        .run();
    },
    removeAll: async (identity: PermissionRuleIdentity) => {
      database
        .delete(permissionRuleOrigins)
        .where(and(...identityConditions(identity)))
        .run();
    },
    list: async (identity: PermissionRuleIdentity) =>
      database
        .select({
          sourceType: permissionRuleOrigins.sourceType,
          sourceId: permissionRuleOrigins.sourceId,
        })
        .from(permissionRuleOrigins)
        .where(and(...identityConditions(identity)))
        .orderBy(
          asc(permissionRuleOrigins.sourceType),
          asc(permissionRuleOrigins.sourceId),
        )
        .all(),
    listForSource: async (
      guildId: string,
      origin: PermissionRuleOrigin,
    ) =>
      database
        .select()
        .from(permissionRuleOrigins)
        .where(
          and(
            eq(permissionRuleOrigins.guildId, guildId),
            eq(permissionRuleOrigins.sourceType, origin.sourceType),
            eq(permissionRuleOrigins.sourceId, origin.sourceId),
          ),
        )
        .orderBy(
          asc(permissionRuleOrigins.subjectType),
          asc(permissionRuleOrigins.subjectId),
          asc(permissionRuleOrigins.objectType),
          asc(permissionRuleOrigins.objectId),
          asc(permissionRuleOrigins.verb),
        )
        .all()
        .map(toIdentity),
  });
