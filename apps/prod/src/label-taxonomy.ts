import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";

import type { ProdDatabase } from "./database.js";
import { guildLabelTaxonomies, labels, ticketLabels } from "./schema.js";

export const DEFAULT_LABEL_SEED_VERSION = 1;
export const MAX_ACTIVE_LABELS = 20;

export const DEFAULT_LABELS = Object.freeze([
  {
    name: "bug",
    description:
      "Unexpected behavior, errors, crashes, or broken functionality.",
  },
  {
    name: "account",
    description:
      "Account access, identity, authentication, or profile problems.",
  },
  {
    name: "gameplay",
    description:
      "Questions or problems involving gameplay systems and mechanics.",
  },
  {
    name: "feedback",
    description:
      "Suggestions, requests, or feedback about the player experience.",
  },
  {
    name: "other",
    description: "Support requests that do not fit another active label.",
  },
] as const);

export type TicketLabel = Readonly<{
  id: string;
  guildId: string;
  name: string;
  normalizedName: string;
  description: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type LabelActor = Readonly<{
  type: "user" | "service";
  id: string;
}>;

export interface LabelTaxonomyStore {
  ensureDefaults(guildId: string): Promise<void>;
  list(
    guildId: string,
    options?: { includeInactive?: boolean },
  ): Promise<readonly TicketLabel[]>;
  findByName(guildId: string, name: string): Promise<TicketLabel | undefined>;
  create(
    guildId: string,
    input: { name: string; description: string },
  ): Promise<TicketLabel>;
  update(
    guildId: string,
    currentName: string,
    input: { name: string; description: string },
  ): Promise<TicketLabel>;
  deactivate(guildId: string, name: string): Promise<TicketLabel>;
  selectForTicket(input: {
    guildId: string;
    ticketId: string;
    labelId: string;
    actor: LabelActor;
  }): Promise<void>;
  listForTicket(ticketId: string): Promise<readonly TicketLabel[]>;
}

export class LabelValidationError extends Error {
  override readonly name = "LabelValidationError";
}

export class DuplicateLabelNameError extends Error {
  override readonly name = "DuplicateLabelNameError";
}

export class LabelNotFoundError extends Error {
  override readonly name = "LabelNotFoundError";
}

export class LabelInactiveError extends Error {
  override readonly name = "LabelInactiveError";
}

export class LabelLimitError extends Error {
  override readonly name = "LabelLimitError";
}

const visibleLength = (value: string): number => [...value].length;

const cleanLabelName = (name: string): string => {
  const cleaned = name.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const length = visibleLength(cleaned);
  if (length < 1 || length > 80) {
    throw new LabelValidationError(
      "Label names must contain between 1 and 80 visible characters.",
    );
  }
  return cleaned;
};

export const normalizeLabelName = (name: string): string =>
  cleanLabelName(name).toLowerCase();

const cleanDescription = (description: string): string => {
  const cleaned = description.normalize("NFKC").trim();
  const length = visibleLength(cleaned);
  if (length < 1 || length > 500) {
    throw new LabelValidationError(
      "Label descriptions must contain between 1 and 500 visible characters.",
    );
  }
  return cleaned;
};

const assertId = (name: string, value: string): void => {
  if (value.trim().length === 0) {
    throw new LabelValidationError(`${name} must not be empty.`);
  }
};

const rowToLabel = (row: typeof labels.$inferSelect): TicketLabel =>
  Object.freeze({ ...row });

const duplicate = (normalizedName: string): DuplicateLabelNameError =>
  new DuplicateLabelNameError(
    `A label named ${JSON.stringify(normalizedName)} already exists in this server.`,
  );

export type CreateSqliteLabelTaxonomyStoreOptions = Readonly<{
  now?: () => string;
  createId?: () => string;
}>;

export const createSqliteLabelTaxonomyStore = (
  database: ProdDatabase,
  options: CreateSqliteLabelTaxonomyStoreOptions = {},
): LabelTaxonomyStore => {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;

  const ensureDefaults = (guildId: string): void => {
    assertId("guildId", guildId);
    database.transaction((transaction) => {
      const timestamp = now();
      const initialized = transaction
        .insert(guildLabelTaxonomies)
        .values({
          guildId,
          seedVersion: DEFAULT_LABEL_SEED_VERSION,
          initializedAt: timestamp,
        })
        .onConflictDoNothing({ target: guildLabelTaxonomies.guildId })
        .run();
      if (initialized.changes === 0) return;
      for (const label of DEFAULT_LABELS) {
        transaction
          .insert(labels)
          .values({
            id: createId(),
            guildId,
            name: label.name,
            normalizedName: normalizeLabelName(label.name),
            description: label.description,
            active: true,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoNothing({
            target: [labels.guildId, labels.normalizedName],
          })
          .run();
      }
    });
  };

  const findByName = (
    guildId: string,
    name: string,
  ): TicketLabel | undefined => {
    assertId("guildId", guildId);
    const row = database
      .select()
      .from(labels)
      .where(
        and(
          eq(labels.guildId, guildId),
          eq(labels.normalizedName, normalizeLabelName(name)),
        ),
      )
      .get();
    return row === undefined ? undefined : rowToLabel(row);
  };

  const store: LabelTaxonomyStore = {
    ensureDefaults: async (guildId) => ensureDefaults(guildId),
    list: async (guildId, listOptions = {}) => {
      assertId("guildId", guildId);
      const rows = listOptions.includeInactive
        ? database
            .select()
            .from(labels)
            .where(eq(labels.guildId, guildId))
            .orderBy(asc(labels.normalizedName))
            .all()
        : database
            .select()
            .from(labels)
            .where(and(eq(labels.guildId, guildId), eq(labels.active, true)))
            .orderBy(asc(labels.normalizedName))
            .all();
      return Object.freeze(rows.map(rowToLabel));
    },
    findByName: async (guildId, name) => findByName(guildId, name),
    create: async (guildId, input) => {
      assertId("guildId", guildId);
      const name = cleanLabelName(input.name);
      const normalizedName = normalizeLabelName(name);
      const description = cleanDescription(input.description);
      return database.transaction((transaction) => {
        if (
          transaction
            .select({ id: labels.id })
            .from(labels)
            .where(
              and(
                eq(labels.guildId, guildId),
                eq(labels.normalizedName, normalizedName),
              ),
            )
            .get() !== undefined
        ) {
          throw duplicate(normalizedName);
        }
        const activeCount = transaction
          .select({ value: count() })
          .from(labels)
          .where(and(eq(labels.guildId, guildId), eq(labels.active, true)))
          .get()!.value;
        if (activeCount >= MAX_ACTIVE_LABELS) {
          throw new LabelLimitError(
            `A server may have at most ${String(MAX_ACTIVE_LABELS)} active labels. Deactivate one before creating another.`,
          );
        }
        const timestamp = now();
        const row = {
          id: createId(),
          guildId,
          name,
          normalizedName,
          description,
          active: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        transaction.insert(labels).values(row).run();
        return rowToLabel(row);
      });
    },
    update: async (guildId, currentName, input) => {
      assertId("guildId", guildId);
      const currentNormalizedName = normalizeLabelName(currentName);
      const name = cleanLabelName(input.name);
      const normalizedName = normalizeLabelName(name);
      const description = cleanDescription(input.description);
      return database.transaction((transaction) => {
        const current = transaction
          .select()
          .from(labels)
          .where(
            and(
              eq(labels.guildId, guildId),
              eq(labels.normalizedName, currentNormalizedName),
            ),
          )
          .get();
        if (current === undefined) {
          throw new LabelNotFoundError("That label no longer exists.");
        }
        if (!current.active) {
          throw new LabelInactiveError(
            "Inactive labels are retained as immutable ticket history.",
          );
        }
        const collision = transaction
          .select({ id: labels.id })
          .from(labels)
          .where(
            and(
              eq(labels.guildId, guildId),
              eq(labels.normalizedName, normalizedName),
            ),
          )
          .get();
        if (collision !== undefined && collision.id !== current.id) {
          throw duplicate(normalizedName);
        }
        const updated = {
          ...current,
          name,
          normalizedName,
          description,
          updatedAt: now(),
        };
        transaction
          .update(labels)
          .set({
            name,
            normalizedName,
            description,
            updatedAt: updated.updatedAt,
          })
          .where(eq(labels.id, current.id))
          .run();
        return rowToLabel(updated);
      });
    },
    deactivate: async (guildId, name) => {
      assertId("guildId", guildId);
      const normalizedName = normalizeLabelName(name);
      return database.transaction((transaction) => {
        const current = transaction
          .select()
          .from(labels)
          .where(
            and(
              eq(labels.guildId, guildId),
              eq(labels.normalizedName, normalizedName),
            ),
          )
          .get();
        if (current === undefined) {
          throw new LabelNotFoundError("That label no longer exists.");
        }
        if (!current.active) {
          throw new LabelInactiveError("That label is already inactive.");
        }
        const updated = { ...current, active: false, updatedAt: now() };
        transaction
          .update(labels)
          .set({ active: false, updatedAt: updated.updatedAt })
          .where(and(eq(labels.id, current.id), eq(labels.active, true)))
          .run();
        return rowToLabel(updated);
      });
    },
    selectForTicket: async (input) => {
      assertId("guildId", input.guildId);
      assertId("ticketId", input.ticketId);
      assertId("labelId", input.labelId);
      assertId("actorId", input.actor.id);
      database.transaction((transaction) => {
        const label = transaction
          .select({ active: labels.active })
          .from(labels)
          .where(
            and(
              eq(labels.id, input.labelId),
              eq(labels.guildId, input.guildId),
            ),
          )
          .get();
        if (label === undefined) {
          throw new LabelNotFoundError("That label no longer exists.");
        }
        if (!label.active) {
          throw new LabelInactiveError(
            "That label is inactive and cannot be selected.",
          );
        }
        transaction
          .insert(ticketLabels)
          .values({
            ticketId: input.ticketId,
            labelId: input.labelId,
            appliedByType: input.actor.type,
            appliedById: input.actor.id,
            createdAt: now(),
          })
          .onConflictDoNothing()
          .run();
      });
    },
    listForTicket: async (ticketId) => {
      assertId("ticketId", ticketId);
      const rows = database
        .select({ label: labels })
        .from(ticketLabels)
        .innerJoin(labels, eq(ticketLabels.labelId, labels.id))
        .where(eq(ticketLabels.ticketId, ticketId))
        .orderBy(asc(labels.normalizedName))
        .all();
      return Object.freeze(rows.map(({ label }) => rowToLabel(label)));
    },
  };
  return Object.freeze(store);
};
