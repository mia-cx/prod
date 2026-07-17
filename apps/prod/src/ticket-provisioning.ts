import { randomUUID } from "node:crypto";
import {
  ChannelType,
  escapeMarkdown,
  ThreadAutoArchiveDuration,
  type Guild,
  type Message,
  type PrivateThreadChannel,
  type TextChannel,
} from "discord.js";

import type { GuildSettingsStore } from "./guild-settings.js";
import type { Ticket, TicketAlias, TicketStore } from "./tickets.js";

export const REPORTER_TICKET_HUB_OVERWRITE = Object.freeze({
  ViewChannel: true,
  ReadMessageHistory: true,
  SendMessagesInThreads: true,
  UseApplicationCommands: true,
  SendMessages: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
} as const);

const RELEASE_REPORTER_TICKET_HUB_OVERWRITE = Object.freeze(
  Object.fromEntries(
    Object.keys(REPORTER_TICKET_HUB_OVERWRITE).map((permission) => [
      permission,
      null,
    ]),
  ),
);

export type OpenTicketInput = Readonly<{
  guild: Guild;
  reporterUserId: string;
  originatingAlias: TicketAlias;
  summary?: string;
}>;

export interface TicketProvisioningDiscord {
  validateReporter(guild: Guild, reporterUserId: string): Promise<void>;
  grantReporterAccess(
    guild: Guild,
    hubChannelId: string,
    reporterUserId: string,
  ): Promise<void>;
  revokeReporterAccess(
    guild: Guild,
    hubChannelId: string,
    reporterUserId: string,
  ): Promise<void>;
  findTicketThread(guild: Guild, ticket: Ticket): Promise<string | undefined>;
  createTicketThread(guild: Guild, ticket: Ticket): Promise<string>;
  addReporter(
    guild: Guild,
    threadId: string,
    reporterUserId: string,
  ): Promise<void>;
  upsertOpeningInstructions(guild: Guild, ticket: Ticket): Promise<string>;
  deleteTicketThread(guild: Guild, threadId: string): Promise<void>;
}

export interface TicketProvisioningService {
  open(input: OpenTicketInput): Promise<Ticket>;
  recover(
    resolveGuild: (guildId: string) => Promise<Guild>,
  ): Promise<Readonly<{ recovered: number; failed: number }>>;
}

export type CreateTicketProvisioningServiceOptions = Readonly<{
  createId?: () => string;
}>;

export class TicketProvisioningError extends Error {
  override readonly name = "TicketProvisioningError";
  readonly ticketId: string;

  constructor(ticketId: string, options: ErrorOptions) {
    super(
      "Prod could not open the private ticket. Please try again or contact support staff.",
      options,
    );
    this.ticketId = ticketId;
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const sanitizeTicketSummary = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  const visible = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (visible.length === 0) return undefined;
  const limited = [...visible].slice(0, 200).join("");
  return escapeMarkdown(limited).replaceAll("@", "@\u200b");
};

const shortTicketId = (ticketId: string): string =>
  ticketId.replaceAll("-", "").slice(0, 8).toLowerCase();

export const ticketThreadName = (ticket: Ticket): string => {
  const summary = ticket.summary
    ?.replaceAll("\\", "")
    .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [`ticket-${shortTicketId(ticket.id)}`, summary]
    .filter((part) => part !== undefined && part.length > 0)
    .join("-")
    .slice(0, 100);
};

export const ticketOpeningInstructions = (ticket: Ticket): string =>
  [
    `## Ticket ${shortTicketId(ticket.id)}`,
    ...(ticket.summary === undefined
      ? []
      : [`**Opening summary:** ${ticket.summary}`]),
    "Send `DEBUGSHARE` to Poke and paste Poke's response in this private thread.",
    "Then tell us what happened, what you expected, and any relevant reproduction context.",
    `-# Managed by Prod · ticket:${ticket.id}`,
  ].join("\n\n");

const requireHub = async (
  guild: Guild,
  channelId: string,
): Promise<TextChannel> => {
  const channel = await guild.channels.fetch(channelId);
  if (channel?.type !== ChannelType.GuildText) {
    throw new Error("The configured support hub is unavailable");
  }
  return channel;
};

const requirePrivateThread = async (
  guild: Guild,
  threadId: string,
): Promise<PrivateThreadChannel> => {
  const channel = await guild.channels.fetch(threadId);
  if (channel?.type !== ChannelType.PrivateThread) {
    throw new Error("The private ticket thread is unavailable");
  }
  return channel;
};

const findNamedThread = async (
  threads: TextChannel["threads"],
  name: string,
): Promise<PrivateThreadChannel | undefined> => {
  const active = await threads.fetchActive();
  const activeMatch = active.threads.find((thread) => thread.name === name);
  if (activeMatch?.type === ChannelType.PrivateThread) return activeMatch;
  const archived = await threads.fetchArchived({ type: "private", limit: 100 });
  const archivedMatch = archived.threads.find((thread) => thread.name === name);
  return archivedMatch?.type === ChannelType.PrivateThread
    ? archivedMatch
    : undefined;
};

const findManagedOpening = async (
  thread: PrivateThreadChannel,
  ticket: Ticket,
): Promise<Message | undefined> => {
  if (ticket.openingMessageId !== undefined) {
    const stored = await thread.messages
      .fetch(ticket.openingMessageId)
      .catch(() => undefined);
    if (stored !== undefined) return stored;
  }
  const marker = `ticket:${ticket.id}`;
  const recent = await thread.messages.fetch({ limit: 100 });
  return recent.find((message) => message.content.includes(marker));
};

export const createTicketProvisioningDiscord =
  (): TicketProvisioningDiscord => {
    const discord: TicketProvisioningDiscord = {
      validateReporter: async (guild, reporterUserId) => {
        await guild.members.fetch(reporterUserId);
      },
      grantReporterAccess: async (guild, hubChannelId, reporterUserId) => {
        const hub = await requireHub(guild, hubChannelId);
        await hub.permissionOverwrites.edit(
          reporterUserId,
          REPORTER_TICKET_HUB_OVERWRITE,
          { reason: "Grant access to Prod private ticket threads" },
        );
      },
      revokeReporterAccess: async (guild, hubChannelId, reporterUserId) => {
        const hub = await requireHub(guild, hubChannelId);
        await hub.permissionOverwrites.edit(
          reporterUserId,
          RELEASE_REPORTER_TICKET_HUB_OVERWRITE,
          { reason: "Release access after Prod ticket provisioning failure" },
        );
      },
      findTicketThread: async (guild, ticket) => {
        if (ticket.threadId !== undefined) {
          const existing = await guild.channels
            .fetch(ticket.threadId)
            .catch(() => null);
          if (
            existing?.type === ChannelType.PrivateThread &&
            existing.parentId === ticket.hubChannelId
          ) {
            return existing.id;
          }
        }
        const hub = await requireHub(guild, ticket.hubChannelId);
        return (await findNamedThread(hub.threads, ticketThreadName(ticket)))
          ?.id;
      },
      createTicketThread: async (guild, ticket) => {
        const hub = await requireHub(guild, ticket.hubChannelId);
        const thread = await hub.threads.create({
          name: ticketThreadName(ticket),
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          reason: `Provision Prod ticket ${ticket.id}`,
        });
        return thread.id;
      },
      addReporter: async (guild, threadId, reporterUserId) => {
        const thread = await requirePrivateThread(guild, threadId);
        await thread.members.add(reporterUserId);
      },
      upsertOpeningInstructions: async (guild, ticket) => {
        if (ticket.threadId === undefined)
          throw new Error("Ticket thread is not stored");
        const thread = await requirePrivateThread(guild, ticket.threadId);
        const content = ticketOpeningInstructions(ticket);
        const existing = await findManagedOpening(thread, ticket);
        const payload = { content, allowedMentions: { parse: [] as const } };
        const message =
          existing === undefined
            ? await thread.send(payload)
            : await existing.edit(payload);
        return message.id;
      },
      deleteTicketThread: async (guild, threadId) => {
        const thread = await guild.channels.fetch(threadId).catch(() => null);
        if (thread?.isThread() === true)
          await thread.delete("Compensate failed Prod ticket provisioning");
      },
    };
    return Object.freeze(discord);
  };

const createKeyedExecutor = () => {
  const tails = new Map<string, Promise<void>>();
  return async <Value>(
    key: string,
    task: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
};

export const createTicketProvisioningService = (
  settings: GuildSettingsStore,
  store: TicketStore,
  discord: TicketProvisioningDiscord,
  options: CreateTicketProvisioningServiceOptions = {},
): TicketProvisioningService => {
  const createId = options.createId ?? randomUUID;
  const execute = createKeyedExecutor();

  const compensate = async (
    guild: Guild,
    ticket: Ticket,
    threadId: string | undefined,
    cause: unknown,
  ): Promise<never> => {
    const compensationErrors: unknown[] = [];
    if (threadId !== undefined) {
      await discord
        .deleteTicketThread(guild, threadId)
        .catch((error: unknown) => compensationErrors.push(error));
    }
    try {
      if (!(await store.hasOtherActiveTicket(ticket))) {
        await discord.revokeReporterAccess(
          guild,
          ticket.hubChannelId,
          ticket.reporterUserId,
        );
      }
    } catch (error) {
      compensationErrors.push(error);
    }
    await store
      .markFailed(ticket.id, errorMessage(cause))
      .catch((error: unknown) => compensationErrors.push(error));
    const eventType =
      compensationErrors.length === 0
        ? "compensation_completed"
        : "compensation_failed";
    await store
      .recordEvent(ticket.id, eventType, {
        error: errorMessage(cause),
        compensationErrors: compensationErrors.map(errorMessage),
      })
      .catch((error: unknown) => compensationErrors.push(error));
    const causeWithCompensation =
      compensationErrors.length === 0
        ? cause
        : new AggregateError(
            [cause, ...compensationErrors],
            "Ticket provisioning and compensation failed",
          );
    throw new TicketProvisioningError(ticket.id, {
      cause: causeWithCompensation,
    });
  };

  const provision = async (
    guild: Guild,
    initial: Ticket,
    recovering: boolean,
  ): Promise<Ticket> => {
    let ticket = initial;
    let threadId = ticket.threadId;
    try {
      if (recovering) {
        await store.recordEvent(ticket.id, "recovery_started");
      }
      await discord.grantReporterAccess(
        guild,
        ticket.hubChannelId,
        ticket.reporterUserId,
      );
      await store.recordProgress(ticket.id, "reporter_access_granted");
      threadId ??= await discord.findTicketThread(guild, ticket);
      if (threadId === undefined)
        threadId = await discord.createTicketThread(guild, ticket);
      if (ticket.threadId !== threadId) {
        await store.recordProgress(
          ticket.id,
          "thread_created",
          { recovered: recovering },
          { threadId },
        );
        ticket = (await store.get(ticket.id))!;
      }
      await discord.addReporter(guild, threadId, ticket.reporterUserId);
      await store.recordProgress(ticket.id, "reporter_added");
      const openingMessageId = await discord.upsertOpeningInstructions(
        guild,
        ticket,
      );
      if (ticket.openingMessageId !== openingMessageId) {
        await store.recordProgress(
          ticket.id,
          "instructions_posted",
          { recovered: recovering },
          { openingMessageId },
        );
      }
      await store.markOpen(ticket.id);
      return (await store.get(ticket.id))!;
    } catch (error) {
      return compensate(guild, ticket, threadId, error);
    }
  };

  const service: TicketProvisioningService = {
    open: async (input) =>
      execute(`${input.guild.id}:${input.reporterUserId}`, async () => {
        const state = await settings.get(input.guild.id);
        if (state.hubChannelId === undefined) {
          throw new Error("This server has not configured a support hub yet.");
        }
        await discord.validateReporter(input.guild, input.reporterUserId);
        const summary = sanitizeTicketSummary(input.summary);
        const ticket = await store.create({
          id: createId(),
          guildId: input.guild.id,
          hubChannelId: state.hubChannelId,
          reporterUserId: input.reporterUserId,
          originatingAlias: input.originatingAlias,
          ...(summary === undefined ? {} : { summary }),
        });
        return provision(input.guild, ticket, false);
      }),
    recover: async (resolveGuild) => {
      let recovered = 0;
      let failed = 0;
      for (const ticket of await store.listProvisioning()) {
        await execute(
          `${ticket.guildId}:${ticket.reporterUserId}`,
          async () => {
            try {
              await provision(await resolveGuild(ticket.guildId), ticket, true);
              recovered += 1;
            } catch {
              failed += 1;
            }
          },
        );
      }
      return Object.freeze({ recovered, failed });
    },
  };
  return Object.freeze(service);
};
