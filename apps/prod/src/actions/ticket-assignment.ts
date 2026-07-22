import { ApplicationCommandOptionType, type GuildMember } from "discord.js";
import { slashCommand, type Action, type DispatchOutcome } from "protocord";

import {
  TicketAssignmentError,
  type TicketAssignmentService,
} from "../ticket-assignment.js";
import type { ProdActionContext } from "./runtime.js";

type AssignmentOperation = "claim" | "unclaim" | "assign" | "unassign";

type TicketAssignmentActionInput = Readonly<{
  operation: AssignmentOperation;
  targetUserId?: string;
}>;

type TicketAssignmentActionOutput = Readonly<{
  operation: AssignmentOperation;
  changed: boolean;
  assigneeCount: number;
}>;

const outputContent = (outcome: DispatchOutcome): string => {
  if (
    outcome.status === "failed" &&
    outcome.error instanceof TicketAssignmentError
  ) {
    return outcome.error.message;
  }
  if (outcome.status !== "executed") {
    return "Prod could not update this ticket's assignments. Please try again.";
  }
  const output = outcome.output as TicketAssignmentActionOutput;
  const messages: Record<AssignmentOperation, readonly [string, string]> = {
    claim: [
      "You are now assigned to this ticket.",
      "You are already assigned to this ticket.",
    ],
    unclaim: [
      "You are no longer assigned to this ticket.",
      "You were not assigned to this ticket.",
    ],
    assign: [
      "That member is now assigned to this ticket.",
      "That member is already assigned to this ticket.",
    ],
    unassign: [
      "That member is no longer assigned to this ticket.",
      "That member was not assigned to this ticket.",
    ],
  };
  return messages[output.operation][output.changed ? 0 : 1];
};

const operations = ["claim", "unclaim", "assign", "unassign"] as const;

export const createTicketAssignmentAction = (
  service: TicketAssignmentService,
): Action<
  TicketAssignmentActionInput,
  TicketAssignmentActionOutput,
  ProdActionContext
> => ({
  name: "ticket_assignment",
  description: "Manage staff assigned to a ticket.",
  input: {
    parse: (value) => {
      if (value === null || typeof value !== "object")
        throw new TypeError("Assignment input must be an object");
      const input = value as Partial<TicketAssignmentActionInput>;
      if (!operations.includes(input.operation as AssignmentOperation))
        throw new TypeError("Assignment operation is invalid");
      if (
        input.targetUserId !== undefined &&
        typeof input.targetUserId !== "string"
      )
        throw new TypeError("Assignment target is invalid");
      return {
        operation: input.operation!,
        ...(input.targetUserId === undefined
          ? {}
          : { targetUserId: input.targetUserId }),
      };
    },
    jsonSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: operations },
        targetUserId: { type: "string" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  triggers: operations.map((operation) =>
    slashCommand<TicketAssignmentActionInput, ProdActionContext>({
      name: operation,
      description:
        operation === "claim"
          ? "Assign yourself to this ticket"
          : operation === "unclaim"
            ? "Remove yourself from this ticket"
            : operation === "assign"
              ? "Assign a staff member to this ticket"
              : "Remove a staff member from this ticket",
      acknowledgement: "defer",
      visibility: "ephemeral",
      options:
        operation === "assign" || operation === "unassign"
          ? [
              {
                type: ApplicationCommandOptionType.User,
                name: "member",
                description: "The staff member",
                required: true,
              },
            ]
          : [],
      parse: (interaction) => ({
        operation,
        ...(operation === "assign" || operation === "unassign"
          ? { targetUserId: interaction.options.getUser("member", true).id }
          : {}),
      }),
      present: async (outcome, interaction) => {
        await interaction.editReply({
          content: outputContent(outcome),
          allowedMentions: { parse: [] },
        });
      },
    }),
  ),
  availability: () => ({ available: true }),
  authorization: () => undefined,
  execute: async (invocation) => {
    const event = invocation.rawEvent as Readonly<{
      guild?: Readonly<{
        members: { fetch(userId: string): Promise<GuildMember> };
      }> | null;
      guildId?: string | null;
      channelId?: string | null;
      user?: Readonly<{ id: string }>;
    }>;
    if (
      event.guild === null ||
      event.guild === undefined ||
      event.guildId === null ||
      event.guildId === undefined ||
      event.channelId === null ||
      event.channelId === undefined ||
      event.user === undefined
    ) {
      throw new TicketAssignmentError(
        "not_a_ticket_thread",
        "This command can only be used in an open ticket thread for this server.",
      );
    }
    const actor = await event.guild.members.fetch(event.user.id);
    const base = { guildId: event.guildId, threadId: event.channelId, actor };
    if (invocation.input.operation === "claim") {
      const result = await service.claim(base);
      return {
        operation: "claim",
        changed: result.added,
        assigneeCount: result.assigneeCount,
      };
    }
    if (invocation.input.operation === "unclaim") {
      const result = await service.unclaim(base);
      return {
        operation: "unclaim",
        changed: result.removed,
        assigneeCount: result.assigneeCount,
      };
    }
    const target = await event.guild.members.fetch(
      invocation.input.targetUserId!,
    );
    if (invocation.input.operation === "assign") {
      const result = await service.assign({ ...base, target });
      return {
        operation: "assign",
        changed: result.added,
        assigneeCount: result.assigneeCount,
      };
    }
    const result = await service.unassign({ ...base, target });
    return {
      operation: "unassign",
      changed: result.removed,
      assigneeCount: result.assigneeCount,
    };
  },
});
