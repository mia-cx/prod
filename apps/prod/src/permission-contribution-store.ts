import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull } from "drizzle-orm";
import type {
  PermissionRule,
  PermissionVerb,
  RuleObject,
} from "@protocord/permissions";

import type { ProdDatabase } from "./database.js";
import type {
  PermissionRuleContribution,
  PermissionRuleIdentity,
  PermissionRuleOrigin,
} from "./permission-rule-provenance.js";
import {
  permissionRuleEvents,
  permissionRuleOriginEvents,
  permissionRuleOrigins,
  permissionRules,
} from "./schema.js";

type Writer = Parameters<Parameters<ProdDatabase["transaction"]>[0]>[0];
type RuleRow = typeof permissionRules.$inferSelect;
type OriginRow = typeof permissionRuleOrigins.$inferSelect;

const toRuleSubject = (row: RuleRow): PermissionRule["subject"] => {
  if (row.subjectType === "everyone") {
    throw new TypeError(
      "Stored everyone rules cannot be managed as permission contributions",
    );
  }
  return { subjectType: row.subjectType, subjectId: row.subjectId };
};

export type PermissionContributionChange =
  | Readonly<{
      kind: "put";
      identity: PermissionRuleIdentity;
      origin: PermissionRuleOrigin;
      permit: "allow" | "deny";
    }>
  | Readonly<{
      kind: "remove";
      identity: PermissionRuleIdentity;
      origin: PermissionRuleOrigin;
    }>
  | Readonly<{
      kind: "remove-identity";
      identity: PermissionRuleIdentity;
    }>
  | Readonly<{
      kind: "clear-source";
      guildId: string;
      origin: PermissionRuleOrigin;
    }>;

export type PermissionOriginEvent = Readonly<{
  id: string;
  identity: PermissionRuleIdentity;
  origin: PermissionRuleOrigin;
  eventType: "added" | "updated" | "removed";
  actorUserId: string;
  beforePermit: "allow" | "deny" | null;
  afterPermit: "allow" | "deny" | null;
  createdAt: string;
}>;

export interface PermissionContributionStore {
  apply(input: {
    changes: readonly PermissionContributionChange[];
    actorUserId: string;
  }): Promise<void>;
  list(
    identity: PermissionRuleIdentity,
  ): Promise<readonly PermissionRuleContribution[]>;
  listForSource(
    guildId: string,
    origin: PermissionRuleOrigin,
  ): Promise<readonly PermissionRuleIdentity[]>;
  listEvents(): Promise<readonly PermissionOriginEvent[]>;
}

export type CreatePermissionContributionStoreOptions = Readonly<{
  createId?: () => string;
  now?: () => string;
}>;

const identityConditions = (identity: PermissionRuleIdentity) =>
  [
    eq(permissionRuleOrigins.guildId, identity.guildId),
    eq(permissionRuleOrigins.subjectType, identity.subject.subjectType),
    eq(permissionRuleOrigins.subjectId, identity.subject.subjectId),
    eq(permissionRuleOrigins.objectType, identity.object.objectType),
    eq(permissionRuleOrigins.objectId, identity.object.objectId),
    eq(permissionRuleOrigins.verb, identity.verb),
  ] as const;

const ruleConditions = (identity: PermissionRuleIdentity) =>
  [
    eq(permissionRules.guildId, identity.guildId),
    isNull(permissionRules.categoryId),
    isNull(permissionRules.channelId),
    eq(permissionRules.subjectType, identity.subject.subjectType),
    eq(permissionRules.subjectId, identity.subject.subjectId),
    eq(permissionRules.objectType, identity.object.objectType),
    eq(permissionRules.objectId, identity.object.objectId),
    eq(permissionRules.verb, identity.verb),
  ] as const;

const identityKey = (identity: PermissionRuleIdentity): string =>
  [
    identity.guildId,
    identity.subject.subjectType,
    identity.subject.subjectId,
    identity.object.objectType,
    identity.object.objectId,
    identity.verb,
  ].join("\u0000");

const toIdentity = (row: OriginRow): PermissionRuleIdentity => ({
  guildId: row.guildId,
  subject: { subjectType: row.subjectType, subjectId: row.subjectId },
  object: { objectType: row.objectType, objectId: row.objectId },
  verb: row.verb as PermissionVerb,
});

const toRule = (row: RuleRow): PermissionRule => ({
  id: row.id,
  context: { guildId: row.guildId },
  subject: toRuleSubject(row),
  object: { objectType: row.objectType, objectId: row.objectId },
  verb: row.verb,
  permit: row.permit,
  createdByUserId: row.createdByUserId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const originRow = (
  identity: PermissionRuleIdentity,
  origin: PermissionRuleOrigin,
  permit: "allow" | "deny",
): typeof permissionRuleOrigins.$inferInsert => ({
  guildId: identity.guildId,
  subjectType: identity.subject.subjectType,
  subjectId: identity.subject.subjectId,
  objectType: identity.object.objectType,
  objectId: identity.object.objectId,
  verb: identity.verb,
  sourceType: origin.sourceType,
  sourceId: origin.sourceId,
  permit,
});

export const createPermissionContributionStore = (
  database: ProdDatabase,
  options: CreatePermissionContributionStoreOptions = {},
): PermissionContributionStore => {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  const writeOriginEvent = (
    writer: Writer,
    identity: PermissionRuleIdentity,
    origin: PermissionRuleOrigin,
    eventType: PermissionOriginEvent["eventType"],
    actorUserId: string,
    beforePermit: "allow" | "deny" | null,
    afterPermit: "allow" | "deny" | null,
  ): void => {
    writer
      .insert(permissionRuleOriginEvents)
      .values({
        id: createId(),
        guildId: identity.guildId,
        subjectType: identity.subject.subjectType,
        subjectId: identity.subject.subjectId,
        objectType: identity.object.objectType,
        objectId: identity.object.objectId,
        verb: identity.verb,
        sourceType: origin.sourceType,
        sourceId: origin.sourceId,
        eventType,
        actorUserId,
        beforePermit,
        afterPermit,
        createdAt: now(),
      })
      .run();
  };

  const writeRuleEvent = (
    writer: Writer,
    eventType: "created" | "updated" | "removed" | "restored",
    actorUserId: string,
    before: PermissionRule | null,
    after: PermissionRule | null,
  ): void => {
    const rule = after ?? before;
    if (rule === null) return;
    writer
      .insert(permissionRuleEvents)
      .values({
        id: createId(),
        guildId: rule.context.guildId,
        ruleId: rule.id,
        eventType,
        actorUserId,
        beforeJson: before === null ? null : JSON.stringify(before),
        afterJson: after === null ? null : JSON.stringify(after),
        createdAt: now(),
      })
      .run();
  };

  const findRule = (
    writer: Writer,
    identity: PermissionRuleIdentity,
  ): RuleRow | undefined =>
    writer
      .select()
      .from(permissionRules)
      .where(and(...ruleConditions(identity)))
      .get();

  const ensureIndependentContribution = (
    writer: Writer,
    identity: PermissionRuleIdentity,
    actorUserId: string,
  ): void => {
    const existingContributions = writer
      .select({ id: permissionRuleOrigins.sourceId })
      .from(permissionRuleOrigins)
      .where(and(...identityConditions(identity)))
      .all();
    if (existingContributions.length !== 0) return;
    const existingRule = findRule(writer, identity);
    if (existingRule === undefined || !existingRule.active) return;
    const origin: PermissionRuleOrigin = {
      sourceType: "independent",
      sourceId: "pre-existing",
    };
    writer
      .insert(permissionRuleOrigins)
      .values(originRow(identity, origin, existingRule.permit))
      .run();
    writeOriginEvent(
      writer,
      identity,
      origin,
      "added",
      actorUserId,
      null,
      existingRule.permit,
    );
  };

  const reconcile = (
    writer: Writer,
    identity: PermissionRuleIdentity,
    actorUserId: string,
  ): void => {
    const contributions = writer
      .select({ permit: permissionRuleOrigins.permit })
      .from(permissionRuleOrigins)
      .where(and(...identityConditions(identity)))
      .all();
    const existingRow = findRule(writer, identity);
    const existing =
      existingRow === undefined || !existingRow.active
        ? null
        : toRule(existingRow);
    if (contributions.length === 0) {
      if (existingRow === undefined || !existingRow.active) return;
      writer
        .update(permissionRules)
        .set({ active: false })
        .where(eq(permissionRules.id, existingRow.id))
        .run();
      writeRuleEvent(writer, "removed", actorUserId, existing, null);
      return;
    }
    const permit = contributions.some(({ permit }) => permit === "deny")
      ? "deny"
      : "allow";
    if (existingRow === undefined) {
      const timestamp = now();
      const created: PermissionRule = {
        id: createId(),
        context: { guildId: identity.guildId },
        subject: identity.subject,
        object: identity.object,
        verb: identity.verb,
        permit,
        createdByUserId: actorUserId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      writer
        .insert(permissionRules)
        .values({
          id: created.id,
          guildId: identity.guildId,
          subjectType: identity.subject.subjectType,
          subjectId: identity.subject.subjectId,
          objectType: identity.object.objectType,
          objectId: identity.object.objectId,
          verb: identity.verb,
          permit,
          createdByUserId: actorUserId,
          createdAt: timestamp,
          updatedAt: timestamp,
          active: true,
        })
        .run();
      writeRuleEvent(writer, "created", actorUserId, null, created);
      return;
    }
    if (existingRow.active && existingRow.permit === permit) return;
    const before = existingRow.active ? toRule(existingRow) : null;
    const after: PermissionRule = {
      ...toRule(existingRow),
      permit,
      updatedAt: now(),
    };
    writer
      .update(permissionRules)
      .set({ permit, updatedAt: after.updatedAt, active: true })
      .where(eq(permissionRules.id, existingRow.id))
      .run();
    writeRuleEvent(
      writer,
      existingRow.active ? "updated" : "restored",
      actorUserId,
      before,
      after,
    );
  };

  const service: PermissionContributionStore = {
    apply: async ({ changes, actorUserId }) => {
      database.transaction((transaction) => {
        const affected = new Map<string, PermissionRuleIdentity>();
        const affect = (identity: PermissionRuleIdentity) => {
          affected.set(identityKey(identity), identity);
        };
        for (const change of changes) {
          if (change.kind === "clear-source") {
            const rows = transaction
              .select()
              .from(permissionRuleOrigins)
              .where(
                and(
                  eq(permissionRuleOrigins.guildId, change.guildId),
                  eq(
                    permissionRuleOrigins.sourceType,
                    change.origin.sourceType,
                  ),
                  eq(permissionRuleOrigins.sourceId, change.origin.sourceId),
                ),
              )
              .all();
            for (const row of rows) {
              const identity = toIdentity(row);
              transaction
                .delete(permissionRuleOrigins)
                .where(
                  and(
                    ...identityConditions(identity),
                    eq(permissionRuleOrigins.sourceType, row.sourceType),
                    eq(permissionRuleOrigins.sourceId, row.sourceId),
                  ),
                )
                .run();
              writeOriginEvent(
                transaction,
                identity,
                change.origin,
                "removed",
                actorUserId,
                row.permit,
                null,
              );
              affect(identity);
            }
            continue;
          }
          const identity = change.identity;
          if (change.kind === "put") {
            ensureIndependentContribution(transaction, identity, actorUserId);
            const existing = transaction
              .select()
              .from(permissionRuleOrigins)
              .where(
                and(
                  ...identityConditions(identity),
                  eq(
                    permissionRuleOrigins.sourceType,
                    change.origin.sourceType,
                  ),
                  eq(permissionRuleOrigins.sourceId, change.origin.sourceId),
                ),
              )
              .get();
            if (existing?.permit === change.permit) continue;
            transaction
              .insert(permissionRuleOrigins)
              .values(originRow(identity, change.origin, change.permit))
              .onConflictDoUpdate({
                target: [
                  permissionRuleOrigins.guildId,
                  permissionRuleOrigins.subjectType,
                  permissionRuleOrigins.subjectId,
                  permissionRuleOrigins.objectType,
                  permissionRuleOrigins.objectId,
                  permissionRuleOrigins.verb,
                  permissionRuleOrigins.sourceType,
                  permissionRuleOrigins.sourceId,
                ],
                set: { permit: change.permit },
              })
              .run();
            writeOriginEvent(
              transaction,
              identity,
              change.origin,
              existing === undefined ? "added" : "updated",
              actorUserId,
              existing?.permit ?? null,
              change.permit,
            );
            affect(identity);
            continue;
          }
          const rows = transaction
            .select()
            .from(permissionRuleOrigins)
            .where(
              change.kind === "remove-identity"
                ? and(...identityConditions(identity))
                : and(
                    ...identityConditions(identity),
                    eq(
                      permissionRuleOrigins.sourceType,
                      change.origin.sourceType,
                    ),
                    eq(permissionRuleOrigins.sourceId, change.origin.sourceId),
                  ),
            )
            .all();
          if (change.kind === "remove-identity") affect(identity);
          for (const row of rows) {
            const origin: PermissionRuleOrigin = {
              sourceType: row.sourceType,
              sourceId: row.sourceId,
            };
            transaction
              .delete(permissionRuleOrigins)
              .where(
                and(
                  ...identityConditions(identity),
                  eq(permissionRuleOrigins.sourceType, row.sourceType),
                  eq(permissionRuleOrigins.sourceId, row.sourceId),
                ),
              )
              .run();
            writeOriginEvent(
              transaction,
              identity,
              origin,
              "removed",
              actorUserId,
              row.permit,
              null,
            );
            affect(identity);
          }
        }
        for (const identity of affected.values()) {
          reconcile(transaction, identity, actorUserId);
        }
      });
    },
    list: async (identity) =>
      database
        .select({
          sourceType: permissionRuleOrigins.sourceType,
          sourceId: permissionRuleOrigins.sourceId,
          permit: permissionRuleOrigins.permit,
        })
        .from(permissionRuleOrigins)
        .where(and(...identityConditions(identity)))
        .orderBy(
          asc(permissionRuleOrigins.sourceType),
          asc(permissionRuleOrigins.sourceId),
        )
        .all(),
    listForSource: async (guildId, origin) =>
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
    listEvents: async () =>
      database
        .select()
        .from(permissionRuleOriginEvents)
        .orderBy(asc(permissionRuleOriginEvents.sequence))
        .all()
        .map((row) => ({
          id: row.id,
          identity: {
            guildId: row.guildId,
            subject: {
              subjectType: row.subjectType,
              subjectId: row.subjectId,
            },
            object: {
              objectType: row.objectType,
              objectId: row.objectId,
            } as RuleObject,
            verb: row.verb as PermissionVerb,
          },
          origin: { sourceType: row.sourceType, sourceId: row.sourceId },
          eventType: row.eventType,
          actorUserId: row.actorUserId,
          beforePermit: row.beforePermit,
          afterPermit: row.afterPermit,
          createdAt: row.createdAt,
        })),
  };
  return Object.freeze(service);
};
