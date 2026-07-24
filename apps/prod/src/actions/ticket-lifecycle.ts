import {
  ApplicationCommandOptionType,
  type Guild,
  type GuildMember,
} from "discord.js";
import type {
  AuthorizationObject,
  AuthorizationService,
  PermissionVerb,
} from "@protocord/permissions";
import { slashCommand, type Action, type DispatchOutcome } from "protocord";

import { createProdAuthorizationContext } from "../authorization.js";
import type { TicketProvisioningService } from "../ticket-provisioning.js";
import type { ProdActionContext } from "./runtime.js";

type LifecycleOperation = "close" | "reopen" | "pause" | "resume";
type TicketLifecycleInput = Readonly<{
  operation: LifecycleOperation;
  ticketId?: string;
  reason?: string;
}>;

const ticketOption = {
  type: ApplicationCommandOptionType.String,
  name: "ticket",
  description: "Ticket number or ID; omit inside its private thread",
  required: false,
} as const;

const present = async (
  outcome: DispatchOutcome,
  interaction: {
    editReply: (payload: {
      content: string;
      allowedMentions: { parse: readonly [] };
    }) => Promise<unknown>;
  },
): Promise<void> => {
  const content =
    outcome.status === "executed" &&
    typeof outcome.output === "object" &&
    outcome.output !== null &&
    "message" in outcome.output
      ? String(outcome.output.message)
      : outcome.status === "failed" && outcome.error instanceof Error
        ? outcome.error.message
        : "Prod could not update that ticket.";
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
};

const requireInvocation = (
  rawEvent: unknown,
): Readonly<{ guild: Guild; userId: string; channelId: string }> => {
  const interaction = rawEvent as Readonly<{
    guild?: Guild | null;
    user?: Readonly<{ id: string }>;
    channelId?: string | null;
  }>;
  if (
    interaction.guild === undefined ||
    interaction.guild === null ||
    interaction.user === undefined ||
    interaction.channelId === undefined ||
    interaction.channelId === null
  ) {
    throw new Error("Ticket lifecycle commands can only be used in a server.");
  }
  return {
    guild: interaction.guild,
    userId: interaction.user.id,
    channelId: interaction.channelId,
  };
};

const permissionVerb = (operation: LifecycleOperation): PermissionVerb => {
  if (operation === "pause") return "pause_triage";
  if (operation === "resume") return "resume_triage";
  return operation;
};

export const createTicketLifecycleAction = (
  tickets: TicketProvisioningService,
  authorization: AuthorizationService,
): Action<
  TicketLifecycleInput,
  Readonly<{ message: string }>,
  ProdActionContext
> => ({
  name: "ticket_lifecycle",
  description: "Pause, resume, close, or reopen a support ticket.",
  input: {
    parse: (value) => value as TicketLifecycleInput,
    jsonSchema: { type: "object" },
  },
  triggers: [
    slashCommand<TicketLifecycleInput, ProdActionContext>({
      name: "close",
      description: "Close a support ticket",
      visibility: "ephemeral",
      options: [
        ticketOption,
        {
          type: ApplicationCommandOptionType.String,
          name: "reason",
          description: "Why the ticket is being closed",
          required: false,
          maxLength: 500,
        },
      ],
      parse: (interaction) => ({
        operation: "close",
        ...(interaction.options.getString("ticket") === null
          ? {}
          : { ticketId: interaction.options.getString("ticket")! }),
        ...(interaction.options.getString("reason") === null
          ? {}
          : { reason: interaction.options.getString("reason")! }),
      }),
      present,
    }),
    slashCommand<TicketLifecycleInput, ProdActionContext>({
      name: "reopen",
      description: "Reopen a support ticket",
      visibility: "ephemeral",
      options: [{ ...ticketOption, required: true }],
      parse: (interaction) => ({
        operation: "reopen",
        ticketId: interaction.options.getString("ticket", true),
      }),
      present,
    }),
    slashCommand<TicketLifecycleInput, ProdActionContext>({
      name: "triage",
      description: "Pause or resume AI triage",
      visibility: "ephemeral",
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "pause",
          description: "Pause AI triage",
          options: [ticketOption],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "resume",
          description: "Resume AI triage",
          options: [ticketOption],
        },
      ],
      parse: (interaction) => ({
        operation: interaction.options.getSubcommand(true) as
          "pause" | "resume",
        ...(interaction.options.getString("ticket") === null
          ? {}
          : { ticketId: interaction.options.getString("ticket")! }),
      }),
      present,
    }),
  ],
  availability: () => ({ available: true }),
  authorization: () => undefined,
  execute: async (invocation, context) => {
    const { guild, userId, channelId } = requireInvocation(invocation.rawEvent);
    const authorizationContext = createProdAuthorizationContext(guild.id);
    const initialMember = await guild.members.fetch({
      user: userId,
      force: true,
    });
    const authorize = (
      member: GuildMember,
      object: AuthorizationObject,
    ): Promise<void> =>
      Promise.resolve(
        authorization.require({
        context: authorizationContext,
        subject: context.createUserAuthorizationSubject(
          member,
          authorizationContext,
        ),
        object,
        verb: permissionVerb(invocation.input.operation),
        }),
      );
    const ticket =
      invocation.input.ticketId === undefined
        ? await tickets.findByThread(guild.id, channelId)
        : await tickets.findByReference(guild.id, invocation.input.ticketId);
    const ticketId = ticket?.id;
    if (ticketId === undefined) {
      await authorize(initialMember, {
        objectType: "settings",
        objectId: "*",
      }).catch(() => undefined);
      throw new Error("Authorization denied");
    }
    const requireAuthorization = async (): Promise<void> => {
      const member = await guild.members.fetch({ user: userId, force: true });
      await authorize(member, { objectType: "ticket", objectId: ticketId });
    };
    await authorize(initialMember, {
      objectType: "ticket",
      objectId: ticketId,
    });
    const details = {
      actorUserId: userId,
      ...(invocation.input.reason === undefined
        ? {}
        : { reason: invocation.input.reason }),
    };
    const method =
      invocation.input.operation === "pause"
        ? tickets.pauseTriage
        : invocation.input.operation === "resume"
          ? tickets.resumeTriage
          : invocation.input.operation === "close"
            ? tickets.close
            : tickets.reopen;
    await method(guild, ticketId, details, requireAuthorization);
    const pastTense = {
      close: "closed",
      reopen: "reopened",
      pause: "paused",
      resume: "resumed",
    }[invocation.input.operation];
    return { message: `Ticket ${ticketId} ${pastTense}.` };
  },
});
