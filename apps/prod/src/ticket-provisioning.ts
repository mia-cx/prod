import { randomUUID } from "node:crypto";
import {
  ChannelType,
  escapeMarkdown,
  OverwriteType,
  RESTJSONErrorCodes,
  Routes,
  ThreadAutoArchiveDuration,
  type Guild,
  type GuildMember,
  type Message,
  type PrivateThreadChannel,
  type TextChannel,
} from "discord.js";

import type { GuildSettingsStore } from "./guild-settings.js";
import {
  createGuildOperationExecutor,
  type ExecuteGuildOperation,
} from "./guild-operation.js";
import {
  captureReporterHubAccess,
  isEmptyPermissionOverwrite,
  reporterHubAccessRestorationPatch,
  REPORTER_TICKET_HUB_OVERWRITE,
  type ReporterHubAccessSnapshot,
} from "./reporter-hub-access.js";
import {
  TicketStateTransitionError,
  type Ticket,
  type TicketAlias,
  type TicketStore,
} from "./tickets.js";

export { REPORTER_TICKET_HUB_OVERWRITE } from "./reporter-hub-access.js";

export type OpenTicketInput = Readonly<{
  guild: Guild;
  reporterUserId: string;
  originatingAlias: TicketAlias;
  summary?: string;
}>;

export type TicketThreadPreparation = Readonly<{
  wasArchived: boolean;
  reporterWasMember: boolean;
}>;

export type OpeningInstructionsMutation = Readonly<{
  messageId: string;
  created: boolean;
  previousContent?: string;
}>;

export interface TicketProvisioningDiscord {
  validateReporter(guild: Guild, reporterUserId: string): Promise<GuildMember>;
  captureReporterAccess(
    guild: Guild,
    hubChannelId: string,
    reporterUserId: string,
  ): Promise<ReporterHubAccessSnapshot>;
  grantReporterAccess(
    guild: Guild,
    hubChannelId: string,
    reporter: GuildMember,
  ): Promise<void>;
  restoreReporterAccess(
    guild: Guild,
    hubChannelId: string,
    reporterUserId: string,
    snapshot: ReporterHubAccessSnapshot,
  ): Promise<void>;
  findTicketThread(guild: Guild, ticket: Ticket): Promise<string | undefined>;
  createTicketThread(guild: Guild, ticket: Ticket): Promise<string>;
  prepareTicketThread(
    guild: Guild,
    threadId: string,
    ticket: Ticket,
  ): Promise<TicketThreadPreparation>;
  addReporter(
    guild: Guild,
    threadId: string,
    reporterUserId: string,
  ): Promise<boolean>;
  removeReporter(
    guild: Guild,
    threadId: string,
    reporterUserId: string,
  ): Promise<void>;
  upsertOpeningInstructions(
    guild: Guild,
    ticket: Ticket,
  ): Promise<OpeningInstructionsMutation>;
  updateTicketThreadName(guild: Guild, ticket: Ticket): Promise<void>;
  reconcileTicketPresentation(guild: Guild, ticket: Ticket): Promise<void>;
  rollbackTicketThread(
    guild: Guild,
    threadId: string,
    ticket: Ticket,
    preparation: TicketThreadPreparation,
    opening?: OpeningInstructionsMutation,
  ): Promise<void>;
  deleteTicketThread(guild: Guild, threadId: string): Promise<void>;
  closeTicketThread(guild: Guild, ticket: Ticket): Promise<void>;
  reopenTicketThread(guild: Guild, ticket: Ticket): Promise<void>;
}

export interface TicketProvisioningService {
  open(input: OpenTicketInput): Promise<Ticket>;
  findByThread(guildId: string, threadId: string): Promise<Ticket | undefined>;
  close(
    guild: Guild,
    ticketId: string,
    details?: Readonly<Record<string, unknown>>,
    recheckAuthorization?: () => Promise<void>,
  ): Promise<Ticket>;
  reopen(
    guild: Guild,
    ticketId: string,
    details?: Readonly<Record<string, unknown>>,
    recheckAuthorization?: () => Promise<void>,
  ): Promise<Ticket>;
  pauseTriage(
    guild: Guild,
    ticketId: string,
    details?: Readonly<Record<string, unknown>>,
    recheckAuthorization?: () => Promise<void>,
  ): Promise<Ticket>;
  resumeTriage(
    guild: Guild,
    ticketId: string,
    details?: Readonly<Record<string, unknown>>,
    recheckAuthorization?: () => Promise<void>,
  ): Promise<Ticket>;
  discoverRecoveryThreads(
    resolveGuild: (guildId: string) => Promise<Guild>,
  ): Promise<Readonly<{ discovered: number; failed: number }>>;
  recover(
    resolveGuild: (guildId: string) => Promise<Guild>,
  ): Promise<Readonly<{ recovered: number; failed: number }>>;
  canReleaseHub(guildId: string, hubChannelId: string): Promise<boolean>;
  suspendHubAccess(guild: Guild, hubChannelId: string): Promise<number>;
  resumeHubAccess(guild: Guild, hubChannelId: string): Promise<number>;
}

export type CreateTicketProvisioningServiceOptions = Readonly<{
  createId?: () => string;
  executeGuildOperation?: ExecuteGuildOperation;
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

export class TicketSetupRequiredError extends Error {
  override readonly name = "TicketSetupRequiredError";

  constructor() {
    super(
      "Support staff must configure a support hub before private tickets can be opened.",
    );
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

export const ticketThreadName = (ticket: Ticket): string => {
  const summary = ticket.summary
    ?.replaceAll("\\", "")
    .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [`ticket-${ticket.number}`, summary]
    .filter((part) => part !== undefined && part.length > 0)
    .join("-")
    .slice(0, 100);
};

const legacyTicketThreadName = (ticket: Ticket): string => {
  const legacyId = ticket.id.replaceAll("-", "").slice(0, 8).toLowerCase();
  const currentName = ticketThreadName(ticket);
  const summary = currentName.slice(`ticket-${ticket.number}`.length);
  return `ticket-${legacyId}${summary}`.slice(0, 100);
};

export const ticketOpeningInstructions = (ticket: Ticket): string =>
  [
    `## Ticket ${ticket.number}`,
    ...(ticket.summary === undefined
      ? []
      : [`**Opening summary:** ${ticket.summary}`]),
    "Send `DEBUGSHARE` to Poke and paste Poke's response in this private thread.",
    "Then tell us what happened, what you expected, and any relevant reproduction context.",
    `-# Managed by Prod · ticket:${ticket.number}`,
  ].join("\n\n");

const requireHub = async (
  guild: Guild,
  channelId: string,
  force = false,
): Promise<TextChannel> => {
  const channel = await guild.channels.fetch(channelId, { force });
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
  names: ReadonlySet<string>,
  ownerId: string,
): Promise<PrivateThreadChannel | undefined> => {
  const active = await threads.fetchActive();
  const activeMatch = active.threads.find(
    (thread) => thread.ownerId === ownerId && names.has(thread.name),
  );
  if (activeMatch?.type === ChannelType.PrivateThread) return activeMatch;
  let before: PrivateThreadChannel | undefined;
  for (let page = 0; page < 10; page += 1) {
    const archived = await threads.fetchArchived({
      type: "private",
      fetchAll: true,
      limit: 100,
      ...(before === undefined ? {} : { before }),
    });
    const archivedMatch = archived.threads.find(
      (thread) => thread.ownerId === ownerId && names.has(thread.name),
    );
    if (archivedMatch?.type === ChannelType.PrivateThread) {
      return archivedMatch;
    }
    if (!archived.hasMore) return undefined;
    const oldest = archived.threads.last();
    if (oldest?.type !== ChannelType.PrivateThread) {
      throw new Error("Discord archived-thread pagination did not advance");
    }
    before = oldest;
  }
  throw new Error("Ticket thread discovery exceeded its safe page limit");
};

const isDiscordErrorCode = (error: unknown, code: number): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

const findManagedOpening = async (
  thread: PrivateThreadChannel,
  ticket: Ticket,
): Promise<Message | undefined> => {
  const footers = new Set([
    `-# Managed by Prod · ticket:${ticket.number}`,
    `-# Managed by Prod · ticket:${ticket.id}`,
  ]);
  const isOwnedOpening = (message: Message): boolean =>
    message.author.id === thread.client.user?.id &&
    message.editable &&
    [...footers].some((footer) => message.content.endsWith(footer));
  if (ticket.openingMessageId !== undefined) {
    const stored = await thread.messages
      .fetch(ticket.openingMessageId)
      .catch((error: unknown) => {
        if (isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownMessage)) {
          return undefined;
        }
        throw error;
      });
    if (stored !== undefined && isOwnedOpening(stored)) return stored;
  }
  const recent = await thread.messages.fetch({ limit: 100 });
  return recent.find(isOwnedOpening);
};

export const createTicketProvisioningDiscord =
  (): TicketProvisioningDiscord => {
    const discord: TicketProvisioningDiscord = {
      validateReporter: async (guild, reporterUserId) => {
        return guild.members.fetch(reporterUserId);
      },
      captureReporterAccess: async (guild, hubChannelId, reporterUserId) => {
        const hub = await requireHub(guild, hubChannelId, true);
        return captureReporterHubAccess(
          hub.permissionOverwrites.cache.get(reporterUserId),
        );
      },
      grantReporterAccess: async (guild, hubChannelId, reporter) => {
        const hub = await requireHub(guild, hubChannelId);
        await hub.permissionOverwrites.edit(
          reporter,
          REPORTER_TICKET_HUB_OVERWRITE,
          {
            type: OverwriteType.Member,
            reason: "Grant access to Prod private ticket threads",
          },
        );
      },
      restoreReporterAccess: async (
        guild,
        hubChannelId,
        reporterUserId,
        snapshot,
      ) => {
        const hub = await requireHub(guild, hubChannelId, true);
        const current = hub.permissionOverwrites.cache.get(reporterUserId);
        const patch = reporterHubAccessRestorationPatch(current, snapshot);
        if (Object.keys(patch).length > 0) {
          await hub.permissionOverwrites.edit(reporterUserId, patch, {
            type: OverwriteType.Member,
            reason: "Restore access after Prod ticket provisioning failure",
          });
        }
        if (!snapshot.overwriteExisted) {
          const refreshed = await requireHub(guild, hubChannelId, true);
          if (
            isEmptyPermissionOverwrite(
              refreshed.permissionOverwrites.cache.get(reporterUserId),
            )
          ) {
            await refreshed.permissionOverwrites.delete(
              reporterUserId,
              "Remove Prod-created empty reporter overwrite",
            );
          }
        }
      },
      findTicketThread: async (guild, ticket) => {
        if (ticket.threadId !== undefined) {
          const existing = await guild.channels
            .fetch(ticket.threadId)
            .catch((error: unknown) => {
              if (
                isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownChannel)
              ) {
                return null;
              }
              throw error;
            });
          if (
            existing?.type === ChannelType.PrivateThread &&
            existing.parentId === ticket.hubChannelId
          ) {
            return existing.id;
          }
        }
        const hub = await requireHub(guild, ticket.hubChannelId);
        const botMember = guild.members.me ?? (await guild.members.fetchMe());
        return (
          await findNamedThread(
            hub.threads,
            new Set([ticketThreadName(ticket), legacyTicketThreadName(ticket)]),
            botMember.id,
          )
        )?.id;
      },
      createTicketThread: async (guild, ticket) => {
        const hub = await requireHub(guild, ticket.hubChannelId);
        const thread = await hub.threads.create({
          name: ticketThreadName(ticket),
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          reason: `Provision Prod ticket ${ticket.number}`,
        });
        return thread.id;
      },
      prepareTicketThread: async (guild, threadId, ticket) => {
        const thread = await requirePrivateThread(guild, threadId);
        if (thread.parentId !== ticket.hubChannelId) {
          throw new Error("Ticket thread does not belong to its stored hub");
        }
        const wasArchived = thread.archived === true;
        const reporterWasMember = await thread.client.rest
          .get(Routes.threadMembers(thread.id, ticket.reporterUserId))
          .then(() => true)
          .catch((error: unknown) => {
            if (isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownMember)) {
              return false;
            }
            throw error;
          });
        if (wasArchived) {
          await thread.setArchived(
            false,
            `Recover Prod ticket ${ticket.number}`,
          );
        }
        return Object.freeze({ wasArchived, reporterWasMember });
      },
      addReporter: async (guild, threadId, reporterUserId) => {
        const thread = await requirePrivateThread(guild, threadId);
        const wasMember = await thread.client.rest
          .get(Routes.threadMembers(thread.id, reporterUserId))
          .then(() => true)
          .catch((error: unknown) => {
            if (isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownMember)) {
              return false;
            }
            throw error;
          });
        if (wasMember) return false;
        await thread.members.add(reporterUserId);
        return true;
      },
      removeReporter: async (guild, threadId, reporterUserId) => {
        const thread = await requirePrivateThread(guild, threadId);
        await thread.members.remove(reporterUserId);
      },
      upsertOpeningInstructions: async (guild, ticket) => {
        if (ticket.threadId === undefined)
          throw new Error("Ticket thread is not stored");
        const thread = await requirePrivateThread(guild, ticket.threadId);
        const content = ticketOpeningInstructions(ticket);
        const existing = await findManagedOpening(thread, ticket);
        const payload = { content, allowedMentions: { parse: [] as const } };
        if (existing === undefined) {
          const message = await thread.send(payload);
          return Object.freeze({ messageId: message.id, created: true });
        }
        const previousContent = existing.content;
        const message = await existing.edit(payload);
        return Object.freeze({
          messageId: message.id,
          created: false,
          previousContent,
        });
      },
      updateTicketThreadName: async (guild, ticket) => {
        if (ticket.threadId === undefined) {
          throw new Error("The ticket thread has not been persisted");
        }
        const thread = await requirePrivateThread(guild, ticket.threadId);
        if (thread.parentId !== ticket.hubChannelId) {
          throw new Error("The private ticket thread belongs to another hub");
        }
        const name = ticketThreadName(ticket);
        if (thread.name !== name) {
          await thread.setName(name, `Number Prod ticket ${ticket.number}`);
        }
      },
      reconcileTicketPresentation: async (guild, ticket) => {
        await discord.updateTicketThreadName(guild, ticket);
        await discord.upsertOpeningInstructions(guild, ticket);
      },
      rollbackTicketThread: async (
        guild,
        threadId,
        ticket,
        preparation,
        opening,
      ) => {
        const thread = await requirePrivateThread(guild, threadId);
        const rollbackErrors: unknown[] = [];
        if (opening !== undefined) {
          try {
            const message = await thread.messages
              .fetch(opening.messageId)
              .catch((error: unknown) => {
                if (
                  isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownMessage)
                ) {
                  return undefined;
                }
                throw error;
              });
            if (message !== undefined) {
              if (opening.created) {
                await message.delete();
              } else if (opening.previousContent !== undefined) {
                await message.edit({
                  content: opening.previousContent,
                  allowedMentions: { parse: [] },
                });
              }
            }
          } catch (error) {
            rollbackErrors.push(error);
          }
        }
        if (!preparation.reporterWasMember) {
          await thread.members
            .remove(ticket.reporterUserId)
            .catch((error: unknown) => rollbackErrors.push(error));
        }
        if (preparation.wasArchived) {
          await thread
            .setArchived(
              true,
              `Roll back failed Prod ticket recovery ${ticket.number}`,
            )
            .catch((error: unknown) => rollbackErrors.push(error));
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            rollbackErrors,
            "Failed to fully roll back recovered ticket thread",
          );
        }
      },
      deleteTicketThread: async (guild, threadId) => {
        const thread = await guild.channels
          .fetch(threadId)
          .catch((error: unknown) => {
            if (isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownChannel)) {
              return null;
            }
            throw error;
          });
        if (thread?.isThread() === true)
          await thread.delete("Compensate failed Prod ticket provisioning");
      },
      closeTicketThread: async (guild, ticket) => {
        if (ticket.threadId === undefined)
          throw new Error("Ticket thread is not stored");
        const thread = await requirePrivateThread(guild, ticket.threadId);
        if (thread.parentId !== ticket.hubChannelId)
          throw new Error("Ticket thread does not belong to its stored hub");
        if (thread.locked !== true) {
          await thread.setLocked(true, `Close Prod ticket ${ticket.number}`);
        }
        if (thread.archived !== true) {
          await thread.setArchived(true, `Close Prod ticket ${ticket.number}`);
        }
      },
      reopenTicketThread: async (guild, ticket) => {
        if (ticket.threadId === undefined)
          throw new Error("Ticket thread is not stored");
        const thread = await requirePrivateThread(guild, ticket.threadId);
        if (thread.parentId !== ticket.hubChannelId)
          throw new Error("Ticket thread does not belong to its stored hub");
        if (thread.archived === true) {
          await thread.setArchived(
            false,
            `Reopen Prod ticket ${ticket.number}`,
          );
        }
        if (thread.locked === true) {
          await thread.setLocked(false, `Reopen Prod ticket ${ticket.number}`);
        }
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
  const executeGuildOperation =
    options.executeGuildOperation ?? createGuildOperationExecutor();
  const restoreReporterAccess = async (
    guild: Guild,
    hubChannelId: string,
    reporterUserId: string,
    snapshot: ReporterHubAccessSnapshot,
  ): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await discord.restoreReporterAccess(
          guild,
          hubChannelId,
          reporterUserId,
          snapshot,
        );
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
  const suspendReporterAccess = async (
    guild: Guild,
    hubChannelId: string,
  ): Promise<number> => {
    const ownerships = await store.listReporterAccess(guild.id, hubChannelId);
    const failures: unknown[] = [];
    for (const ownership of ownerships) {
      await restoreReporterAccess(
        guild,
        hubChannelId,
        ownership.reporterUserId,
        ownership.snapshot,
      ).catch((error: unknown) => failures.push(error));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to suspend all reporter access for unsafe support hub",
      );
    }
    return ownerships.length;
  };

  const compensate = async (
    guild: Guild,
    ticket: Ticket,
    createdThreadId: string | undefined,
    accessOwnershipStarted: boolean,
    preparation: TicketThreadPreparation | undefined,
    opening: OpeningInstructionsMutation | undefined,
    cause: unknown,
  ): Promise<never> => {
    const compensationErrors: unknown[] = [];
    if (createdThreadId !== undefined) {
      await discord
        .deleteTicketThread(guild, createdThreadId)
        .catch((error: unknown) => compensationErrors.push(error));
    } else if (ticket.threadId !== undefined && preparation !== undefined) {
      await discord
        .rollbackTicketThread(
          guild,
          ticket.threadId,
          ticket,
          preparation,
          opening,
        )
        .catch((error: unknown) => compensationErrors.push(error));
    }
    try {
      if (
        accessOwnershipStarted &&
        !(await store.hasOtherActiveTicket(ticket))
      ) {
        const snapshot = await store.getReporterAccess(ticket);
        if (snapshot === undefined) {
          throw new Error("Reporter hub access ownership is missing");
        }
        await restoreReporterAccess(
          guild,
          ticket.hubChannelId,
          ticket.reporterUserId,
          snapshot,
        );
        await store.finishReporterAccess(ticket);
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
    let createdThreadId: string | undefined;
    let accessOwnershipStarted = false;
    let preparation: TicketThreadPreparation | undefined;
    let opening: OpeningInstructionsMutation | undefined;
    try {
      if (recovering) {
        accessOwnershipStarted =
          (await store.getReporterAccess(ticket)) !== undefined;
        await store.recordEvent(ticket.id, "recovery_started");
      }
      const reporter = await discord.validateReporter(
        guild,
        ticket.reporterUserId,
      );
      if (threadId === undefined && recovering) {
        threadId = await discord.findTicketThread(guild, ticket);
        if (threadId !== undefined) {
          await store.recordProgress(
            ticket.id,
            "thread_created",
            { recovered: true, legacyDiscovery: true },
            { threadId },
          );
          ticket = (await store.get(ticket.id))!;
        }
      }
      const snapshot = await discord.captureReporterAccess(
        guild,
        ticket.hubChannelId,
        ticket.reporterUserId,
      );
      await store.beginReporterAccess(ticket, snapshot);
      accessOwnershipStarted = true;
      await discord.grantReporterAccess(guild, ticket.hubChannelId, reporter);
      await store.recordProgress(ticket.id, "reporter_access_granted");
      if (threadId === undefined) {
        threadId = await discord.createTicketThread(guild, ticket);
        createdThreadId = threadId;
      }
      if (ticket.threadId !== threadId) {
        await store.recordProgress(
          ticket.id,
          "thread_created",
          { recovered: recovering },
          { threadId },
        );
        ticket = (await store.get(ticket.id))!;
      }
      preparation = await discord.prepareTicketThread(guild, threadId, ticket);
      await discord.addReporter(guild, threadId, ticket.reporterUserId);
      await store.recordProgress(ticket.id, "reporter_added");
      opening = await discord.upsertOpeningInstructions(guild, ticket);
      if (recovering) {
        await discord.updateTicketThreadName(guild, ticket);
      }
      if (ticket.openingMessageId !== opening.messageId) {
        await store.recordProgress(
          ticket.id,
          "instructions_posted",
          { recovered: recovering },
          { openingMessageId: opening.messageId },
        );
      }
      await store.markOpen(ticket.id);
      return (await store.get(ticket.id))!;
    } catch (error) {
      return compensate(
        guild,
        ticket,
        createdThreadId,
        accessOwnershipStarted,
        preparation,
        opening,
        error,
      );
    }
  };

  const service: TicketProvisioningService = {
    findByThread: (guildId, threadId) => store.findByThread(guildId, threadId),
    open: async (input) =>
      executeGuildOperation(input.guild.id, async () => {
        const state = await settings.get(input.guild.id);
        if (state.hubChannelId === undefined) {
          throw new TicketSetupRequiredError();
        }
        const hubChannelId = state.hubChannelId;
        return execute(`hub:${input.guild.id}:${hubChannelId}`, async () => {
          const summary = sanitizeTicketSummary(input.summary);
          const ticket = await store.create({
            id: createId(),
            guildId: input.guild.id,
            hubChannelId,
            reporterUserId: input.reporterUserId,
            originatingAlias: input.originatingAlias,
            ...(summary === undefined ? {} : { summary }),
          });
          return provision(input.guild, ticket, false);
        });
      }),
    close: async (guild, ticketId, details = {}, recheckAuthorization) => {
      const initial = await store.get(ticketId);
      if (initial === undefined || initial.guildId !== guild.id)
        throw new Error(`Ticket ${ticketId} does not exist in this guild`);
      return executeGuildOperation(guild.id, () =>
        execute(`hub:${guild.id}:${initial.hubChannelId}`, async () => {
          await recheckAuthorization?.();
          const fresh = await store.get(ticketId);
          if (fresh === undefined || fresh.guildId !== guild.id)
            throw new Error(`Ticket ${ticketId} does not exist in this guild`);
          let closed: Ticket;
          let closeTransitionApplied = false;
          try {
            closed = await store.close(ticketId, details);
            closeTransitionApplied = true;
          } catch (error) {
            if (
              !(error instanceof TicketStateTransitionError) ||
              error.status !== "closed"
            ) {
              throw error;
            }
            const persisted = await store.get(ticketId);
            if (persisted === undefined) {
              throw new Error(`Ticket ${ticketId} no longer exists`);
            }
            closed = persisted;
          }
          let threadError: unknown;
          await discord
            .closeTicketThread(guild, closed)
            .catch((error: unknown) => {
              threadError = error;
            });
          const cleanupErrors: unknown[] = [];
          const persistedAfterThread = await store.get(ticketId);
          if (persistedAfterThread?.status === "open") {
            const reporter = await discord.validateReporter(
              guild,
              persistedAfterThread.reporterUserId,
            );
            await discord.grantReporterAccess(
              guild,
              persistedAfterThread.hubChannelId,
              reporter,
            );
            await discord.reopenTicketThread(guild, persistedAfterThread);
            if (persistedAfterThread.threadId === undefined) {
              throw new Error("The ticket thread has not been persisted");
            }
            await discord.addReporter(
              guild,
              persistedAfterThread.threadId,
              persistedAfterThread.reporterUserId,
            );
            return persistedAfterThread;
          }
          let hasOtherActiveTicket =
            await store.hasOtherActiveTicket(closed);
          let closeCompensated = false;
          if (
            threadError !== undefined &&
            closeTransitionApplied
          ) {
            try {
              await discord.reopenTicketThread(guild, closed);
              await store.reopen(ticketId, {
                ...details,
                compensatedCloseFailure: true,
              });
              closeCompensated = true;
            } catch (error) {
              cleanupErrors.push(error);
              await discord
                .closeTicketThread(guild, closed)
                .catch((closeError: unknown) => cleanupErrors.push(closeError));
            }
          }
          const persistedAfterCompensation = await store.get(ticketId);
          if (
            persistedAfterCompensation?.status === "open" &&
            !closeCompensated
          ) {
            return persistedAfterCompensation;
          }
          hasOtherActiveTicket =
            persistedAfterCompensation?.status === "open"
              ? true
              : await store.hasOtherActiveTicket(closed);
          if (!hasOtherActiveTicket) {
            const snapshot = await store.getReporterAccess(closed);
            if (snapshot !== undefined) {
              await restoreReporterAccess(
                guild,
                closed.hubChannelId,
                closed.reporterUserId,
                snapshot,
              )
                .then(() => store.finishReporterAccess(closed))
                .catch((error: unknown) => cleanupErrors.push(error));
            }
          }
          if (threadError !== undefined || cleanupErrors.length > 0) {
            const errors = [
              ...(threadError === undefined ? [] : [threadError]),
              ...cleanupErrors,
            ];
            throw errors.length === 1
              ? errors[0]
              : new AggregateError(
                  errors,
                  "Ticket close reconciliation failed",
                );
          }
          return closed;
        }),
      );
    },
    reopen: async (guild, ticketId, details = {}, recheckAuthorization) => {
      const initial = await store.get(ticketId);
      if (initial === undefined || initial.guildId !== guild.id)
        throw new Error(`Ticket ${ticketId} does not exist in this guild`);
      return executeGuildOperation(guild.id, () =>
        execute(`hub:${guild.id}:${initial.hubChannelId}`, async () => {
          const fresh = await store.get(ticketId);
          if (fresh === undefined || fresh.guildId !== guild.id)
            throw new Error(`Ticket ${ticketId} does not exist in this guild`);
          if (fresh.status !== "closed") {
            throw new TicketStateTransitionError(
              ticketId,
              "reopen",
              fresh.status,
              fresh.triageStatus,
            );
          }
          const guildSettings = await settings.get(guild.id);
          if (guildSettings.hubChannelId !== fresh.hubChannelId) {
            throw new Error(
              "This ticket belongs to a former support hub and cannot be reopened.",
            );
          }
          const reporter = await discord.validateReporter(
            guild,
            fresh.reporterUserId,
          );
          const accessIsShared = await store.hasOtherActiveTicket(fresh);
          const snapshot = await discord.captureReporterAccess(
            guild,
            fresh.hubChannelId,
            fresh.reporterUserId,
          );
          let ownershipStarted = false;
          let discordMutationStarted = false;
          let reporterMembershipAdded = false;
          let ownedSnapshot = snapshot;
          try {
            await recheckAuthorization?.();
            ownedSnapshot = await store.beginReporterAccess(fresh, snapshot);
            ownershipStarted = true;
            discordMutationStarted = true;
            await discord.grantReporterAccess(
              guild,
              fresh.hubChannelId,
              reporter,
            );
            await discord.reopenTicketThread(guild, fresh);
            if (fresh.threadId === undefined) {
              throw new Error("The ticket thread has not been persisted");
            }
            reporterMembershipAdded = await discord.addReporter(
              guild,
              fresh.threadId,
              fresh.reporterUserId,
            );
            return await store.reopen(ticketId, details);
          } catch (error) {
            if (
              error instanceof TicketStateTransitionError &&
              error.status === "open"
            ) {
              return (await store.get(ticketId))!;
            }
            const persisted = await store.get(ticketId);
            if (persisted?.status === "open") {
              return persisted;
            }
            const compensationErrors: unknown[] = [];
            if (discordMutationStarted) {
              await discord
                .closeTicketThread(guild, fresh)
                .catch((compensationError: unknown) =>
                  compensationErrors.push(compensationError),
                );
            }
            if (reporterMembershipAdded && fresh.threadId !== undefined) {
              await discord
                .removeReporter(
                  guild,
                  fresh.threadId,
                  fresh.reporterUserId,
                )
                .catch((compensationError: unknown) =>
                  compensationErrors.push(compensationError),
                );
            }
            if (ownershipStarted) {
              await restoreReporterAccess(
                guild,
                fresh.hubChannelId,
                fresh.reporterUserId,
                accessIsShared ? snapshot : ownedSnapshot,
              )
                .then(() =>
                  accessIsShared
                    ? undefined
                    : store.finishReporterAccess(fresh),
                )
                .catch((compensationError: unknown) =>
                  compensationErrors.push(compensationError),
                );
            }
            if (compensationErrors.length === 0) throw error;
            throw new AggregateError(
              [error, ...compensationErrors],
              "Ticket reopen and compensation failed",
            );
          }
        }),
      );
    },
    pauseTriage: async (
      guild,
      ticketId,
      details = {},
      recheckAuthorization,
    ) => {
      const ticket = await store.get(ticketId);
      if (ticket === undefined || ticket.guildId !== guild.id)
        throw new Error(`Ticket ${ticketId} does not exist in this guild`);
      return executeGuildOperation(guild.id, async () => {
        await recheckAuthorization?.();
        return store.pauseTriage(ticketId, details);
      });
    },
    resumeTriage: async (
      guild,
      ticketId,
      details = {},
      recheckAuthorization,
    ) => {
      const ticket = await store.get(ticketId);
      if (ticket === undefined || ticket.guildId !== guild.id)
        throw new Error(`Ticket ${ticketId} does not exist in this guild`);
      return executeGuildOperation(guild.id, async () => {
        await recheckAuthorization?.();
        return store.resumeTriage(ticketId, details);
      });
    },
    discoverRecoveryThreads: async (resolveGuild) => {
      let discovered = 0;
      let failed = 0;
      for (const ticket of await store.listProvisioning()) {
        if (ticket.threadId !== undefined) continue;
        await executeGuildOperation(ticket.guildId, () =>
          execute(`hub:${ticket.guildId}:${ticket.hubChannelId}`, async () => {
            try {
              const state = await settings.get(ticket.guildId);
              if (state.hubChannelId !== ticket.hubChannelId) return;
              const guild = await resolveGuild(ticket.guildId);
              const threadId = await discord.findTicketThread(guild, ticket);
              if (threadId === undefined) return;
              await store.recordProgress(
                ticket.id,
                "thread_created",
                { recovered: true, legacyDiscovery: true },
                { threadId },
              );
              discovered += 1;
            } catch {
              failed += 1;
            }
          }),
        );
      }
      return Object.freeze({ discovered, failed });
    },
    recover: async (resolveGuild) => {
      let recovered = 0;
      let failed = 0;
      const provisioningTickets = await store.listProvisioning();
      const provisioningTicketIds = new Set(
        provisioningTickets.map(({ id }) => id),
      );
      for (const ticket of provisioningTickets) {
        await executeGuildOperation(ticket.guildId, () =>
          execute(`hub:${ticket.guildId}:${ticket.hubChannelId}`, async () => {
            try {
              const guild = await resolveGuild(ticket.guildId);
              const state = await settings.get(ticket.guildId);
              if (state.hubChannelId !== ticket.hubChannelId) {
                await compensate(
                  guild,
                  ticket,
                  undefined,
                  (await store.getReporterAccess(ticket)) !== undefined,
                  undefined,
                  undefined,
                  new Error(
                    "The configured support hub changed before ticket recovery",
                  ),
                );
              }
              await provision(guild, ticket, true);
              recovered += 1;
            } catch {
              failed += 1;
            }
          }),
        );
      }
      for (const ticket of await store.listOpen()) {
        if (provisioningTicketIds.has(ticket.id)) continue;
        await executeGuildOperation(ticket.guildId, () =>
          execute(`hub:${ticket.guildId}:${ticket.hubChannelId}`, async () => {
            try {
              const guild = await resolveGuild(ticket.guildId);
              const state = await settings.get(ticket.guildId);
              if (state.hubChannelId !== ticket.hubChannelId) return;
              await discord.reconcileTicketPresentation(guild, ticket);
            } catch {
              failed += 1;
            }
          }),
        );
      }
      return Object.freeze({ recovered, failed });
    },
    canReleaseHub: async (guildId, hubChannelId) =>
      !(await store.hasActiveTickets(guildId, hubChannelId)),
    suspendHubAccess: async (guild, hubChannelId) =>
      execute(`hub:${guild.id}:${hubChannelId}`, () =>
        suspendReporterAccess(guild, hubChannelId),
      ),
    resumeHubAccess: async (guild, hubChannelId) =>
      executeGuildOperation(guild.id, () =>
        execute(`hub:${guild.id}:${hubChannelId}`, async () => {
          const state = await settings.get(guild.id);
          if (state.hubChannelId !== hubChannelId) {
            return suspendReporterAccess(guild, hubChannelId);
          }
          const ownerships = await store.listResumableReporterAccess(
            guild.id,
            hubChannelId,
          );
          const resumableReporterIds = new Set(
            ownerships.map(({ reporterUserId }) => reporterUserId),
          );
          const allOwnerships = await store.listReporterAccess(
            guild.id,
            hubChannelId,
          );
          for (const ownership of allOwnerships) {
            if (resumableReporterIds.has(ownership.reporterUserId)) continue;
            await restoreReporterAccess(
              guild,
              hubChannelId,
              ownership.reporterUserId,
              ownership.snapshot,
            );
            await store.finishReporterAccessFor(
              guild.id,
              hubChannelId,
              ownership.reporterUserId,
            );
          }
          let resumed = 0;
          for (const ownership of ownerships) {
            let reporter: GuildMember;
            try {
              reporter = await discord.validateReporter(
                guild,
                ownership.reporterUserId,
              );
            } catch (error) {
              if (isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownMember)) {
                continue;
              }
              throw error;
            }
            await discord.grantReporterAccess(guild, hubChannelId, reporter);
            resumed += 1;
          }
          return resumed;
        }),
      ),
  };
  return Object.freeze(service);
};
