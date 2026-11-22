import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import type { ProdDatabase } from "./database.js";
import { LabelNotFoundError } from "./label-taxonomy.js";
import {
  labels,
  processedReporterMessages,
  ticketAssignees,
  ticketAssigneeSuggestions,
  ticketEvents,
  ticketLabels,
  tickets,
  ticketTriageResults,
} from "./schema.js";

export type ExpectedTriageState = Readonly<{ updatedAt: string }>;
export type TriageCompletion = Readonly<{
  internalSummary: string;
  reporterSummary: string;
  labelIds: readonly string[];
  suggestedUserIds: readonly string[];
}>;

export const createSqliteTriageStore = (
  database: ProdDatabase,
  options: Readonly<{ now?: () => string; createId?: () => string }> = {},
) => {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;
  const eligible = (db: Pick<ProdDatabase, "select">, ticketId: string) => {
    const ticket = db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .get();
    if (ticket?.status !== "open" || ticket.triageStatus !== "collecting")
      return undefined;
    return db
      .select({ id: ticketAssignees.assigneeUserId })
      .from(ticketAssignees)
      .where(eq(ticketAssignees.ticketId, ticketId))
      .limit(1)
      .get() === undefined
      ? ticket
      : undefined;
  };
  return Object.freeze({
    claimReporterMessage: async (
      ticketId: string,
      messageId: string,
    ): Promise<boolean> => {
      if (!messageId.trim())
        throw new TypeError("Message id must not be empty");
      return (
        database
          .insert(processedReporterMessages)
          .values({
            ticketId,
            messageId,
            claimedAt: now(),
          })
          .onConflictDoNothing()
          .run().changes > 0
      );
    },
    isTriageEligible: async (ticketId: string): Promise<boolean> =>
      eligible(database, ticketId) !== undefined,
    completeTriage: async (
      ticketId: string,
      expected: ExpectedTriageState,
      result: TriageCompletion,
    ): Promise<Readonly<{ discarded: boolean }>> =>
      database.transaction((transaction) => {
        const ticket = eligible(transaction, ticketId);
        if (ticket === undefined || ticket.updatedAt !== expected.updatedAt)
          return { discarded: true };
        if (!result.internalSummary.trim() || !result.reporterSummary.trim()) {
          throw new TypeError("Triage summaries must not be empty");
        }
        const labelIds = [...new Set(result.labelIds)];
        for (const labelId of labelIds) {
          if (
            transaction
              .select({ id: labels.id })
              .from(labels)
              .where(
                and(eq(labels.id, labelId), eq(labels.guildId, ticket.guildId)),
              )
              .get() === undefined
          )
            throw new LabelNotFoundError("That label no longer exists.");
        }
        const timestamp = now();
        transaction
          .insert(ticketTriageResults)
          .values({
            ticketId,
            internalSummary: result.internalSummary,
            reporterSummary: result.reporterSummary,
            completedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: ticketTriageResults.ticketId,
            set: {
              internalSummary: result.internalSummary,
              reporterSummary: result.reporterSummary,
              completedAt: timestamp,
            },
          })
          .run();
        for (const labelId of labelIds) {
          transaction
            .insert(ticketLabels)
            .values({
              ticketId,
              labelId,
              appliedByType: "service",
              appliedById: "prod-ai",
              createdAt: timestamp,
            })
            .onConflictDoNothing()
            .run();
        }
        transaction
          .delete(ticketAssigneeSuggestions)
          .where(eq(ticketAssigneeSuggestions.ticketId, ticketId))
          .run();
        for (const userId of new Set(result.suggestedUserIds)) {
          if (!userId.trim())
            throw new TypeError("Suggested user id must not be empty");
          transaction
            .insert(ticketAssigneeSuggestions)
            .values({
              ticketId,
              userId,
              suggestedBy: "prod-ai",
              createdAt: timestamp,
            })
            .run();
        }
        transaction
          .update(tickets)
          .set({ triageStatus: "ready", updatedAt: timestamp })
          .where(eq(tickets.id, ticketId))
          .run();
        transaction
          .insert(ticketEvents)
          .values({
            id: createId(),
            ticketId,
            guildId: ticket.guildId,
            eventType: "triage_completed",
            detailsJson: JSON.stringify({
              actorType: "service",
              actorId: "prod-ai",
              labelIds,
              suggestedUserIds: [...new Set(result.suggestedUserIds)],
            }),
            createdAt: timestamp,
          })
          .run();
        return { discarded: false };
      }),
  });
};
