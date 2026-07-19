import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";

import type { ProdDatabase } from "./database.js";
import { guildLabelTaxonomies, labels, ticketLabels } from "./schema.js";

export const DEFAULT_LABEL_SEED_VERSION = 1;
export const MAX_LABELS = 25;

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
    description: "Support requests that do not fit another label.",
  },
] as const);

export type TicketLabel = Readonly<{
  id: string;
  guildId: string;
  name: string;
  normalizedName: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type LabelActor = Readonly<{
  type: "user" | "service";
  id: string;
}>;

export interface LabelTaxonomyStore {
  ensureDefaults(guildId: string): Promise<void>;
  list(guildId: string): Promise<readonly TicketLabel[]>;
  findById(guildId: string, labelId: string): Promise<TicketLabel | undefined>;
  findByName(guildId: string, name: string): Promise<TicketLabel | undefined>;
  create(
    guildId: string,
    input: { name: string; description?: string },
  ): Promise<TicketLabel>;
  update(
    guildId: string,
    labelId: string,
    input: { name: string; description?: string },
  ): Promise<TicketLabel>;
  delete(guildId: string, labelId: string): Promise<void>;
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

const cleanDescription = (description: string | undefined): string | null => {
  const cleaned = description?.normalize("NFKC").trim() ?? "";
  const length = visibleLength(cleaned);
  if (length > 500) {
    throw new LabelValidationError(
      "Label descriptions may contain at most 500 visible characters.",
    );
  }
  return cleaned.length === 0 ? null : cleaned;
};

const assertId = (name: string, value: string): void => {
  if (value.trim().length === 0) {
    throw new LabelValidationError(`${name} must not be empty.`);
  }
};

const rowToLabel = (row: typeof labels.$inferSelect): TicketLabel => {
  const { description, ...required } = row;
  return Object.freeze({
    ...required,
    ...(description === null ? {} : { description }),
  });
};

const duplicate = (normalizedName: string): DuplicateLabelNameError =>
  new DuplicateLabelNameError(
    `A label named ${JSON.stringify(normalizedName)} already exists in this server.`,
  );

export type CreateSqliteLabelTaxonomyStoreOptions = Readonly<{
  now?: () => string;
  createId?: () => string;
}>;

type TaxonomyInitializer = Pick<ProdDatabase, "insert">;

export const createSqliteLabelTaxonomyStore = (
  database: ProdDatabase,
  options: CreateSqliteLabelTaxonomyStoreOptions = {},
): LabelTaxonomyStore => {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;

  const initializeDefaults = (
    writer: TaxonomyInitializer,
    guildId: string,
    timestamp: string,
  ): void => {
    const initialized = writer
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
      writer
        .insert(labels)
        .values({
          id: createId(),
          guildId,
          name: label.name,
          normalizedName: normalizeLabelName(label.name),
          description: label.description,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing({
          target: [labels.guildId, labels.normalizedName],
        })
        .run();
    }
  };

  const ensureDefaults = (guildId: string): void => {
    assertId("guildId", guildId);
    database.transaction((transaction) => {
      initializeDefaults(transaction, guildId, now());
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

  const findById = (
    guildId: string,
    labelId: string,
  ): TicketLabel | undefined => {
    assertId("guildId", guildId);
    assertId("labelId", labelId);
    const row = database
      .select()
      .from(labels)
      .where(and(eq(labels.guildId, guildId), eq(labels.id, labelId)))
      .get();
    return row === undefined ? undefined : rowToLabel(row);
  };

  const store: LabelTaxonomyStore = {
    ensureDefaults: async (guildId) => ensureDefaults(guildId),
    list: async (guildId) => {
      assertId("guildId", guildId);
      const rows = database
        .select()
        .from(labels)
        .where(eq(labels.guildId, guildId))
        .orderBy(asc(labels.normalizedName))
        .all();
      return Object.freeze(rows.map(rowToLabel));
    },
    findById: async (guildId, labelId) => findById(guildId, labelId),
    findByName: async (guildId, name) => findByName(guildId, name),
    create: async (guildId, input) => {
      assertId("guildId", guildId);
      const name = cleanLabelName(input.name);
      const normalizedName = normalizeLabelName(name);
      const description = cleanDescription(input.description);
      const result = database.transaction((transaction) => {
        initializeDefaults(transaction, guildId, now());
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
          return { error: duplicate(normalizedName) } as const;
        }
        const labelCount = transaction
          .select({ value: count() })
          .from(labels)
          .where(eq(labels.guildId, guildId))
          .get()!.value;
        if (labelCount >= MAX_LABELS) {
          return {
            error: new LabelLimitError(
              `A server may have at most ${String(MAX_LABELS)} labels. Delete one before creating another.`,
            ),
          } as const;
        }
        const timestamp = now();
        const row = {
          id: createId(),
          guildId,
          name,
          normalizedName,
          description,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        transaction.insert(labels).values(row).run();
        return { label: rowToLabel(row) } as const;
      });
      if ("error" in result) throw result.error;
      return result.label;
    },
    update: async (guildId, labelId, input) => {
      assertId("guildId", guildId);
      assertId("labelId", labelId);
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
              eq(labels.id, labelId),
            ),
          )
          .get();
        if (current === undefined) {
          throw new LabelNotFoundError("That label no longer exists.");
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
    delete: async (guildId, labelId) => {
      assertId("guildId", guildId);
      assertId("labelId", labelId);
      const result = database
        .delete(labels)
        .where(and(eq(labels.guildId, guildId), eq(labels.id, labelId)))
        .run();
      if (result.changes === 0) {
        throw new LabelNotFoundError("That label no longer exists.");
      }
    },
    selectForTicket: async (input) => {
      assertId("guildId", input.guildId);
      assertId("ticketId", input.ticketId);
      assertId("labelId", input.labelId);
      assertId("actorId", input.actor.id);
      database.transaction((transaction) => {
        const label = transaction
          .select({ id: labels.id })
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
