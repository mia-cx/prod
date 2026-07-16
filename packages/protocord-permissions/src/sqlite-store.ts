import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type {
  AuthorizationContext,
  PermissionRule,
  PermissionRuleInput,
  PermissionRuleStore,
  RemovePermissionRuleInput,
  RuleObject,
  UpsertPermissionRuleInput,
} from "./contracts.js";
import { permissionRuleEvents, permissionRules } from "./schema.js";
import {
  authorizationContextsEqual,
  InvalidAuthorizationInputError,
  validateAuthorizationContext,
  validatePermissionRule,
  validatePermissionRuleActor,
  validatePermissionRuleInput,
} from "./validation.js";

type PermissionRuleRow = typeof permissionRules.$inferSelect;
const eventOrder = [
  asc(permissionRuleEvents.sequence),
] as const;

export type PermissionRuleEvent = Readonly<{
  id: string;
  context: AuthorizationContext;
  ruleId: string;
  eventType: "created" | "updated" | "removed" | "restored";
  actorUserId: string;
  before: PermissionRule | null;
  after: PermissionRule | null;
  createdAt: string;
}>;

export interface SqlitePermissionRuleStore extends PermissionRuleStore {
  listEvents(ruleId?: string): Promise<readonly PermissionRuleEvent[]>;
}

export class PermissionRuleConflictError extends Error {
  override readonly name = "PermissionRuleConflictError";
}

export type CreateSqlitePermissionRuleStoreOptions = Readonly<{
  createId?: () => string;
  now?: () => string;
}>;

const contextConditions = (context: AuthorizationContext): readonly SQL[] => [
  eq(permissionRules.guildId, context.guildId),
  context.categoryId === undefined
    ? isNull(permissionRules.categoryId)
    : eq(permissionRules.categoryId, context.categoryId),
  context.channelId === undefined
    ? isNull(permissionRules.channelId)
    : eq(permissionRules.channelId, context.channelId),
];

const identityConditions = (rule: PermissionRuleInput): readonly SQL[] => [
  ...contextConditions(rule.context),
  eq(permissionRules.subjectType, rule.subject.subjectType),
  eq(permissionRules.subjectId, rule.subject.subjectId),
  eq(permissionRules.objectType, rule.object.objectType),
  eq(permissionRules.objectId, rule.object.objectId),
  eq(permissionRules.verb, rule.verb),
];

const toRule = (row: PermissionRuleRow): PermissionRule => {
  const context: AuthorizationContext = {
    guildId: row.guildId,
    ...(row.categoryId === null ? {} : { categoryId: row.categoryId }),
    ...(row.channelId === null ? {} : { channelId: row.channelId }),
  };
  const subject =
    row.subjectType === "everyone"
      ? ({
          subjectType: "everyone",
          subjectId: row.subjectId as "*",
        } as const)
      : { subjectType: row.subjectType, subjectId: row.subjectId };
  const result: PermissionRule = {
    id: row.id,
    context,
    subject,
    object: { objectType: row.objectType, objectId: row.objectId },
    verb: row.verb,
    permit: row.permit,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  validatePermissionRule(result);
  return result;
};

const toRow = (rule: PermissionRule): typeof permissionRules.$inferInsert => ({
  id: rule.id,
  guildId: rule.context.guildId,
  categoryId: rule.context.categoryId,
  channelId: rule.context.channelId,
  subjectType: rule.subject.subjectType,
  subjectId: rule.subject.subjectId,
  objectType: rule.object.objectType,
  objectId: rule.object.objectId,
  verb: rule.verb,
  permit: rule.permit,
  createdByUserId: rule.createdByUserId,
  createdAt: rule.createdAt,
  updatedAt: rule.updatedAt,
  active: true,
});

const serializeRule = (rule: PermissionRule | null): string | null =>
  rule === null ? null : JSON.stringify(rule);

const parseRule = (value: string | null): PermissionRule | null => {
  if (value === null) return null;
  const parsed = JSON.parse(value) as PermissionRule;
  validatePermissionRule(parsed);
  return parsed;
};

export const createSqlitePermissionRuleStore = (
  database: BetterSQLite3Database,
  options: CreateSqlitePermissionRuleStoreOptions = {},
): SqlitePermissionRuleStore => {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  const writeEvent = (
    writer: Pick<BetterSQLite3Database, "insert">,
    eventType: PermissionRuleEvent["eventType"],
    actorUserId: string,
    before: PermissionRule | null,
    after: PermissionRule | null,
  ): void => {
    const rule = after ?? before;
    if (rule === null) return;
    writer.insert(permissionRuleEvents).values({
      id: createId(),
      guildId: rule.context.guildId,
      categoryId: rule.context.categoryId,
      channelId: rule.context.channelId,
      ruleId: rule.id,
      eventType,
      actorUserId,
      beforeJson: serializeRule(before),
      afterJson: serializeRule(after),
      createdAt: now(),
    }).run();
  };

  const listForContext = async (
    context: AuthorizationContext,
  ): Promise<readonly PermissionRule[]> => {
    validateAuthorizationContext(context);
    return database
      .select()
      .from(permissionRules)
      .where(
        and(...contextConditions(context), eq(permissionRules.active, true)),
      )
      .all()
      .map(toRule);
  };

  return Object.freeze({
    upsert: async (input: UpsertPermissionRuleInput): Promise<void> => {
      validateAuthorizationContext(input.context);
      validatePermissionRuleInput(input.rule);
      validatePermissionRuleActor(input.actor);
      if (!authorizationContextsEqual(input.context, input.rule.context)) {
        throw new InvalidAuthorizationInputError(
          "rule context must match the trusted mutation context",
        );
      }
      database.transaction((transaction) => {
        const matchingIdentity = transaction
          .select()
          .from(permissionRules)
          .where(and(...identityConditions(input.rule)))
          .get();
        const matchingId = transaction
          .select()
          .from(permissionRules)
          .where(eq(permissionRules.id, input.rule.id))
          .get();

        if (
          matchingId !== undefined &&
          matchingIdentity?.id !== matchingId.id
        ) {
          throw new PermissionRuleConflictError(
            "Permission rule ID belongs to a different rule identity",
          );
        }

        if (matchingIdentity === undefined) {
          const timestamp = now();
          const created: PermissionRule = {
            ...input.rule,
            createdByUserId: input.actor.actorId,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          transaction.insert(permissionRules).values(toRow(created)).run();
          writeEvent(
            transaction,
            "created",
            input.actor.actorId,
            null,
            created,
          );
          return;
        }

        const before = toRule(matchingIdentity);
        const after: PermissionRule = {
          ...before,
          permit: input.rule.permit,
          updatedAt: now(),
        };
        transaction
          .update(permissionRules)
          .set(toRow(after))
          .where(eq(permissionRules.id, matchingIdentity.id))
          .run();
        writeEvent(
          transaction,
          matchingIdentity.active ? "updated" : "restored",
          input.actor.actorId,
          matchingIdentity.active ? before : null,
          after,
        );
      });
    },
    remove: async (input: RemovePermissionRuleInput): Promise<void> => {
      if (input.ruleId.length === 0) {
        throw new InvalidAuthorizationInputError("ruleId must not be empty");
      }
      validateAuthorizationContext(input.context);
      validatePermissionRuleActor(input.actor);
      database.transaction((transaction) => {
        const existing = transaction
          .update(permissionRules)
          .set({ active: false })
          .where(
            and(
              eq(permissionRules.id, input.ruleId),
              ...contextConditions(input.context),
              eq(permissionRules.active, true),
            ),
          )
          .returning()
          .get();
        if (existing === undefined) return;
        const before = toRule(existing);
        writeEvent(
          transaction,
          "removed",
          input.actor.actorId,
          before,
          null,
        );
      });
    },
    listForContext,
    listForObject: async (input: {
      context: AuthorizationContext;
      object: RuleObject;
    }): Promise<readonly PermissionRule[]> =>
      (await listForContext(input.context)).filter(
        (rule) =>
          rule.object.objectType === input.object.objectType &&
          rule.object.objectId === input.object.objectId,
      ),
    listEvents: async (
      ruleId?: string,
    ): Promise<readonly PermissionRuleEvent[]> => {
      const rows =
        ruleId === undefined
          ? database
              .select()
              .from(permissionRuleEvents)
              .orderBy(...eventOrder)
              .all()
          : database
              .select()
              .from(permissionRuleEvents)
              .where(eq(permissionRuleEvents.ruleId, ruleId))
              .orderBy(...eventOrder)
              .all();
      return rows.map((row) => ({
        id: row.id,
        context: {
          guildId: row.guildId,
          ...(row.categoryId === null
            ? {}
            : { categoryId: row.categoryId }),
          ...(row.channelId === null ? {} : { channelId: row.channelId }),
        },
        ruleId: row.ruleId,
        eventType: row.eventType,
        actorUserId: row.actorUserId,
        before: parseRule(row.beforeJson),
        after: parseRule(row.afterJson),
        createdAt: row.createdAt,
      }));
    },
  });
};
