import type {
  AuthorizationContext,
  AuthorizationService,
  DiscordMemberLike,
  PermissionVerb,
  UserAuthorizationSubject,
} from "@protocord/permissions";

import { createProdAuthorizationContext } from "./authorization.js";
import {
  TicketAssignmentStateError,
  type Ticket,
  type TicketStore,
} from "./tickets.js";

export type TicketSelfAssignmentInput = Readonly<{
  guildId: string;
  threadId: string;
  actor: DiscordMemberLike;
}>;

export type TicketDelegatedAssignmentInput = Readonly<{
  guildId: string;
  threadId: string;
  actor: DiscordMemberLike;
  target: DiscordMemberLike;
}>;

export type TicketAssigneeAddedResult = Readonly<{
  ticket: Ticket;
  added: boolean;
  assigneeCount: number;
  triagePaused: boolean;
}>;

export type TicketAssigneeRemovedResult = Readonly<{
  ticket: Ticket;
  removed: boolean;
  assigneeCount: number;
}>;

export interface TicketAssignmentService {
  claim(input: TicketSelfAssignmentInput): Promise<TicketAssigneeAddedResult>;
  unclaim(
    input: TicketSelfAssignmentInput,
  ): Promise<TicketAssigneeRemovedResult>;
  assign(
    input: TicketDelegatedAssignmentInput,
  ): Promise<TicketAssigneeAddedResult>;
  unassign(
    input: TicketDelegatedAssignmentInput,
  ): Promise<TicketAssigneeRemovedResult>;
}

export type CreateTicketAssignmentServiceDependencies = Readonly<{
  tickets: TicketStore;
  authorization: AuthorizationService;
  createUserAuthorizationSubject: (
    member: DiscordMemberLike,
    context: AuthorizationContext,
  ) => UserAuthorizationSubject;
}>;

export class TicketAssignmentError extends Error {
  override readonly name = "TicketAssignmentError";
  readonly code: "not_a_ticket_thread" | "unauthorized" | "target_ineligible";

  constructor(code: TicketAssignmentError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const requireOpenTicket = async (
  tickets: TicketStore,
  guildId: string,
  threadId: string,
): Promise<Ticket> => {
  const ticket = await tickets.getByThreadId(threadId);
  if (
    ticket === undefined ||
    ticket.guildId !== guildId ||
    ticket.status !== "open"
  ) {
    throw new TicketAssignmentError(
      "not_a_ticket_thread",
      "This command can only be used in an open ticket thread for this server.",
    );
  }
  return ticket;
};

const mapAssignmentStateRace = async <Result>(
  mutation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await mutation();
  } catch (error) {
    if (error instanceof TicketAssignmentStateError) {
      throw new TicketAssignmentError(
        "not_a_ticket_thread",
        "This command can only be used in an open ticket thread for this server.",
      );
    }
    throw error;
  }
};

export const createTicketAssignmentService = (
  dependencies: CreateTicketAssignmentServiceDependencies,
): TicketAssignmentService => {
  const check = async (
    member: DiscordMemberLike,
    context: AuthorizationContext,
    ticket: Ticket,
    verb: PermissionVerb,
  ): Promise<boolean> =>
    (
      await dependencies.authorization.check({
        context,
        subject: dependencies.createUserAuthorizationSubject(member, context),
        object: { objectType: "ticket", objectId: ticket.id },
        verb,
      })
    ).allowed;

  const requireActorPermission = async (
    member: DiscordMemberLike,
    context: AuthorizationContext,
    ticket: Ticket,
    verb: PermissionVerb,
    message: string,
  ): Promise<void> => {
    if (!(await check(member, context, ticket, verb))) {
      throw new TicketAssignmentError("unauthorized", message);
    }
  };

  const service: TicketAssignmentService = {
    claim: async (input) => {
      const ticket = await requireOpenTicket(
        dependencies.tickets,
        input.guildId,
        input.threadId,
      );
      const context = createProdAuthorizationContext(input.guildId);
      await requireActorPermission(
        input.actor,
        context,
        ticket,
        "claim_self",
        "You do not have permission to claim this ticket.",
      );
      const result = await mapAssignmentStateRace(() =>
        dependencies.tickets.addAssignee({
          ticketId: ticket.id,
          assigneeUserId: input.actor.id,
          assignedByUserId: input.actor.id,
          method: "self_claim",
        }),
      );
      return Object.freeze({ ticket, ...result });
    },
    unclaim: async (input) => {
      const ticket = await requireOpenTicket(
        dependencies.tickets,
        input.guildId,
        input.threadId,
      );
      const context = createProdAuthorizationContext(input.guildId);
      await requireActorPermission(
        input.actor,
        context,
        ticket,
        "unclaim_self",
        "You do not have permission to unclaim this ticket.",
      );
      const result = await mapAssignmentStateRace(() =>
        dependencies.tickets.removeAssignee({
          ticketId: ticket.id,
          assigneeUserId: input.actor.id,
          removedByUserId: input.actor.id,
        }),
      );
      return Object.freeze({ ticket, ...result });
    },
    assign: async (input) => {
      const ticket = await requireOpenTicket(
        dependencies.tickets,
        input.guildId,
        input.threadId,
      );
      const context = createProdAuthorizationContext(input.guildId);
      await requireActorPermission(
        input.actor,
        context,
        ticket,
        "assign_other",
        "You do not have delegated assignment permission for this ticket.",
      );
      if (!(await check(input.target, context, ticket, "claim_self"))) {
        throw new TicketAssignmentError(
          "target_ineligible",
          "That member is not eligible to be assigned to this ticket.",
        );
      }
      const result = await mapAssignmentStateRace(() =>
        dependencies.tickets.addAssignee({
          ticketId: ticket.id,
          assigneeUserId: input.target.id,
          assignedByUserId: input.actor.id,
          method: "delegated",
        }),
      );
      return Object.freeze({ ticket, ...result });
    },
    unassign: async (input) => {
      const ticket = await requireOpenTicket(
        dependencies.tickets,
        input.guildId,
        input.threadId,
      );
      const context = createProdAuthorizationContext(input.guildId);
      await requireActorPermission(
        input.actor,
        context,
        ticket,
        "unassign_other",
        "You do not have delegated assignment permission for this ticket.",
      );
      if (input.target.id === input.actor.id) {
        await requireActorPermission(
          input.actor,
          context,
          ticket,
          "unclaim_self",
          "You do not have permission to unclaim this ticket.",
        );
      }
      const result = await mapAssignmentStateRace(() =>
        dependencies.tickets.removeAssignee({
          ticketId: ticket.id,
          assigneeUserId: input.target.id,
          removedByUserId: input.actor.id,
        }),
      );
      return Object.freeze({ ticket, ...result });
    },
  };
  return Object.freeze(service);
};
