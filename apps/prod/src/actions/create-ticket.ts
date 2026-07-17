import { ApplicationCommandOptionType, type Guild } from "discord.js";
import {
  slashCommand,
  textCommandTrigger,
  type Action,
  type DispatchOutcome,
} from "protocord";

import {
  TicketProvisioningError,
  type TicketProvisioningService,
} from "../ticket-provisioning.js";
import type { TicketAlias } from "../tickets.js";
import type { ProdActionContext } from "./runtime.js";

type CreateTicketInput = Readonly<{
  alias: TicketAlias;
  summary?: string;
}>;

type CreateTicketOutput = Readonly<{
  threadUrl: string;
}>;

const aliases = ["issue", "report", "debugshare"] as const;

const outcomeContent = (outcome: DispatchOutcome): string => {
  if (
    outcome.status === "executed" &&
    typeof outcome.output === "object" &&
    outcome.output !== null &&
    "threadUrl" in outcome.output &&
    typeof outcome.output.threadUrl === "string"
  ) {
    return outcome.output.threadUrl;
  }
  if (
    outcome.status === "failed" &&
    outcome.error instanceof TicketProvisioningError
  ) {
    return outcome.error.message;
  }
  return "Prod could not open the private ticket. Please try again or contact support staff.";
};

const resolveDiscordInvocation = (
  rawEvent: unknown,
): Readonly<{ guild: Guild; reporterUserId: string }> => {
  const event = rawEvent as Readonly<{
    guild?: Guild | null;
    user?: Readonly<{ id: string }>;
    author?: Readonly<{ id: string }>;
  }>;
  const guild = event.guild;
  const reporterUserId = event.user?.id ?? event.author?.id;
  if (guild === null || guild === undefined || reporterUserId === undefined) {
    throw new Error("Private tickets can only be opened inside a server.");
  }
  return { guild, reporterUserId };
};

export const createTicketAction = (
  tickets: TicketProvisioningService,
): Action<CreateTicketInput, CreateTicketOutput, ProdActionContext> => ({
  name: "create_ticket",
  description: "Open a private support ticket.",
  input: {
    parse: (input) => {
      if (!input || typeof input !== "object") {
        throw new TypeError("Create ticket input must be an object");
      }
      const candidate = input as Partial<CreateTicketInput>;
      if (!aliases.includes(candidate.alias as TicketAlias)) {
        throw new TypeError("Create ticket alias is invalid");
      }
      if (
        candidate.summary !== undefined &&
        typeof candidate.summary !== "string"
      ) {
        throw new TypeError("Ticket summary must be text");
      }
      return {
        alias: candidate.alias!,
        ...(candidate.summary === undefined
          ? {}
          : { summary: candidate.summary }),
      };
    },
    jsonSchema: {
      type: "object",
      properties: {
        alias: { type: "string", enum: aliases },
        summary: { type: "string", maxLength: 200 },
      },
      required: ["alias"],
      additionalProperties: false,
    },
  },
  triggers: aliases.flatMap((alias) => [
    slashCommand<CreateTicketInput, ProdActionContext>({
      name: alias,
      description: "Open a private support ticket",
      acknowledgement: "defer",
      visibility: "ephemeral",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "summary",
          description: "A short summary of the problem",
          required: false,
          maxLength: 200,
        },
      ],
      parse: (interaction) => ({
        alias,
        ...(interaction.options.getString("summary") === null
          ? {}
          : { summary: interaction.options.getString("summary")! }),
      }),
      present: async (outcome, interaction) => {
        await interaction.editReply({
          content: outcomeContent(outcome),
          allowedMentions: { parse: [] },
        });
      },
    }),
    textCommandTrigger<CreateTicketInput, ProdActionContext>({
      name: alias,
      description: "Open a private support ticket",
      parse: (argumentTail) => ({
        alias,
        ...(argumentTail.trim().length === 0
          ? {}
          : { summary: argumentTail.trim() }),
      }),
      present: async (_trigger, _message, outcome, context) => {
        await context.replyToTextCommand?.(outcomeContent(outcome), 30_000);
      },
    }),
  ]),
  availability: () => ({ available: true }),
  authorization: () => undefined,
  execute: async (invocation) => {
    const { guild, reporterUserId } = resolveDiscordInvocation(
      invocation.rawEvent,
    );
    const ticket = await tickets.open({
      guild,
      reporterUserId,
      originatingAlias: invocation.input.alias,
      ...(invocation.input.summary === undefined
        ? {}
        : { summary: invocation.input.summary }),
    });
    return {
      threadUrl: `https://discord.com/channels/${ticket.guildId}/${ticket.threadId!}`,
    };
  },
});
