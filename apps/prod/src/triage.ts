import { readFileSync } from "node:fs";
import type { Message } from "discord.js";
import type { Logger } from "pino";
import {
  ModelCredentialError,
  type SecureModelConfigurationStore,
} from "@mia-cx/protocord-model-settings";
import type {
  AuthorizationService,
  PermissionVerb,
  UserAuthorizationSubject,
} from "@protocord/permissions";

import type { GuildSettingsStore } from "./guild-settings.js";
import { DEFAULT_TRIAGE_RATE_LIMITS, type TriageRateLimits } from "./config.js";
import type { LabelTaxonomyStore } from "./label-taxonomy.js";
import { OpenRouterError, type createOpenRouterClient } from "./openrouter.js";
import type { Ticket, TicketStore } from "./tickets.js";
import type { createSqliteTriageStore } from "./triage-store.js";

const systemPrompt = readFileSync(
  new URL("../prompts/triage-system.md", import.meta.url),
  "utf8",
).trim();

export type TriageTranscriptMessage = Readonly<{
  id: string;
  authorId: string;
  content: string;
  isAssistant: boolean;
}>;

export interface TriageDiscordPort {
  recentMessages(message: Message): Promise<readonly TriageTranscriptMessage[]>;
  candidates(message: Message): Promise<readonly UserAuthorizationSubject[]>;
  post(message: Message, content: string): Promise<void>;
}

export const triageTools = [
  {
    name: "ask_follow_up",
    description: "Ask the reporter one concise question. No internal metadata.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 1000 },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "complete_triage",
    description:
      "Complete actionable triage with separate private and reporter-safe summaries. Suggest staff, never assign them.",
    parameters: {
      type: "object",
      properties: {
        internal_summary: { type: "string", minLength: 1, maxLength: 8000 },
        reporter_summary: { type: "string", minLength: 1, maxLength: 1600 },
        labels: {
          type: "array",
          items: { type: "string" },
          maxItems: 25,
          uniqueItems: true,
        },
        suggested_assignee_ids: {
          type: "array",
          items: { type: "string" },
          maxItems: 50,
          uniqueItems: true,
        },
      },
      required: [
        "internal_summary",
        "reporter_summary",
        "labels",
        "suggested_assignee_ids",
      ],
      additionalProperties: false,
    },
  },
] as const;

const untrusted = (tag: string, value: unknown) =>
  `<${tag}>\n${JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}\n</${tag}>`;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const strings = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((item: unknown) => text(item, 200)) &&
  new Set(value).size === value.length;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createTriageService = (
  dependencies: Readonly<{
    tickets: Pick<TicketStore, "getByThreadId" | "get">;
    store: ReturnType<typeof createSqliteTriageStore>;
    settings: Pick<GuildSettingsStore, "get">;
    labels: Pick<LabelTaxonomyStore, "list">;
    models: Pick<SecureModelConfigurationStore, "resolve">;
    client: ReturnType<typeof createOpenRouterClient>;
    authorization: AuthorizationService;
    discord: TriageDiscordPort;
    logger: Pick<Logger, "warn">;
    deploymentKey?: string;
    now?: () => number;
    rateLimits?: TriageRateLimits;
  }>,
) => {
  const queues = new Map<string, Promise<void>>();
  const now = dependencies.now ?? Date.now;
  const limits = dependencies.rateLimits ?? DEFAULT_TRIAGE_RATE_LIMITS;
  let requests: { guildId: string; at: number }[] = [];
  const warn = (reason: string) =>
    dependencies.logger.warn({ triageReason: reason }, "AI triage skipped");
  const allowed = async (ticket: Ticket, verb: PermissionVerb) =>
    (
      await dependencies.authorization.check({
        context: { guildId: ticket.guildId },
        subject: { subjectType: "service", subjectId: "prod-ai" },
        object: { objectType: "ticket", objectId: ticket.id },
        verb,
      })
    ).allowed;
  const candidates = async (message: Message, ticket: Ticket) => {
    const eligible: string[] = [];
    for (const subject of await dependencies.discord.candidates(message)) {
      if (
        (
          await dependencies.authorization.check({
            context: { guildId: ticket.guildId },
            subject,
            object: { objectType: "ticket", objectId: ticket.id },
            verb: "claim_self",
          })
        ).allowed
      )
        eligible.push(subject.subjectId);
      if (eligible.length === 50) break;
    }
    return eligible;
  };
  const process = async (message: Message, ticketId: string) => {
    const ticket = await dependencies.tickets.get(ticketId);
    if (!ticket || !(await dependencies.store.isTriageEligible(ticketId)))
      return;
    const timestamp = now();
    requests = requests.filter(
      (entry) => entry.at > timestamp - limits.windowMs,
    );
    if (
      requests.length >= limits.global ||
      requests.filter((entry) => entry.guildId === ticket.guildId).length >=
        limits.guild
    ) {
      warn("rate_limited");
      return;
    }
    const model = await dependencies.models.resolve(
      ticket.guildId,
      "triage",
      dependencies.deploymentKey,
    );
    if (!model.available) {
      warn("missing_credential");
      return;
    }
    const settings = await dependencies.settings.get(ticket.guildId);
    const labelReference = (await dependencies.labels.list(ticket.guildId)).map(
      ({ id, name, description }) => ({ id, name, description }),
    );
    const candidateIds = await candidates(message, ticket);
    const recent = (await dependencies.discord.recentMessages(message))
      .filter(
        (entry) =>
          entry.authorId === ticket.reporterUserId || entry.isAssistant,
      )
      .filter((entry) => entry.id !== message.id);
    recent.push({
      id: message.id,
      authorId: message.author.id,
      content: message.content,
      isAssistant: false,
    });
    let remaining = 12_000;
    const transcript = recent
      .slice(-20)
      .reverse()
      .map((entry) => {
        const content = entry.content.slice(0, remaining);
        remaining -= content.length;
        return { role: entry.isAssistant ? "assistant" : "reporter", content };
      })
      .filter((entry) => entry.content.length > 0)
      .reverse();
    const messages: Record<string, unknown>[] = [
      {
        role: "system",
        content: [
          settings.systemPrompt,
          settings.productKnowledgePrompt,
          settings.safetyPrompt,
          settings.tone,
          settings.supportWorkflowPrompt,
          systemPrompt,
        ].join("\n\n"),
      },
      {
        role: "user",
        content: untrusted("untrusted_reference_data", {
          labels: labelReference,
          eligible_assignee_ids: candidateIds,
        }),
      },
      {
        role: "user",
        content: untrusted("untrusted_ticket_transcript", transcript),
      },
    ];
    for (let round = 0; round < 3; round++) {
      if (!(await dependencies.store.isTriageEligible(ticketId))) return;
      const at = now();
      requests = requests.filter((entry) => entry.at > at - limits.windowMs);
      if (
        requests.length >= limits.global ||
        requests.filter((entry) => entry.guildId === ticket.guildId).length >=
          limits.guild
      ) {
        warn("rate_limited");
        return;
      }
      requests.push({ guildId: ticket.guildId, at });
      const response = await dependencies.client.complete({
        apiKey: model.apiKey,
        model: model.modelId,
        messages,
        tools: triageTools.map((tool) => ({
          type: "function",
          function: tool,
        })),
        tool_choice: "required",
      });
      const calls = response.tool_calls;
      if (!calls?.length || calls.length > 4) {
        warn("invalid_output");
        return;
      }
      messages.push({ ...response });
      for (const call of calls) {
        let error =
          "Invalid tool arguments. Use exactly one eligible tool and the documented schema.";
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = undefined;
        }
        if (!(await dependencies.store.isTriageEligible(ticketId))) return;
        if (calls.length === 1 && object(args)) {
          if (
            call.function.name === "ask_follow_up" &&
            Object.keys(args).length === 1 &&
            text(args.question, 1000)
          ) {
            if (!(await allowed(ticket, "view_metadata")))
              error = "Tool authorization denied.";
            else {
              if (await dependencies.store.isTriageEligible(ticketId))
                await dependencies.discord.post(message, args.question);
              return;
            }
          } else if (
            call.function.name === "complete_triage" &&
            Object.keys(args).length === 4 &&
            text(args.internal_summary, 8000) &&
            text(args.reporter_summary, 1600) &&
            strings(args.labels, 25) &&
            strings(args.suggested_assignee_ids, 50)
          ) {
            const currentLabels = await dependencies.labels.list(
              ticket.guildId,
            );
            const currentCandidates = await candidates(message, ticket);
            if (
              !args.labels.every((id) =>
                currentLabels.some((label) => label.id === id),
              ) ||
              !args.suggested_assignee_ids.every((id) =>
                currentCandidates.includes(id),
              )
            )
              error =
                "Unknown label or ineligible assignee. Use only current reference IDs.";
            else if (
              !(await allowed(ticket, "complete_triage")) ||
              (args.labels.length > 0 && !(await allowed(ticket, "label"))) ||
              (args.suggested_assignee_ids.length > 0 &&
                !(await allowed(ticket, "suggest_assignee")))
            )
              error = "Tool authorization denied.";
            else {
              const result = await dependencies.store.completeTriage(
                ticketId,
                { updatedAt: ticket.updatedAt },
                {
                  internalSummary: args.internal_summary,
                  reporterSummary: args.reporter_summary,
                  labelIds: args.labels,
                  suggestedUserIds: args.suggested_assignee_ids,
                },
              );
              if (!result.discarded) {
                const completed = await dependencies.tickets.get(ticketId);
                if (
                  completed?.status === "open" &&
                  completed.triageStatus === "ready"
                ) {
                  await dependencies.discord.post(
                    message,
                    `thanks for the details. ${args.reporter_summary}`,
                  );
                }
              }
              return;
            }
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error }),
        });
      }
    }
    warn("tool_round_limit");
  };
  return Object.freeze({
    handleReporterMessage: async (message: Message): Promise<boolean> => {
      try {
        if (!message.guildId || message.author.bot || message.webhookId)
          return false;
        const ticket = await dependencies.tickets.getByThreadId(
          message.channelId,
        );
        if (
          !ticket ||
          ticket.guildId !== message.guildId ||
          ticket.reporterUserId !== message.author.id ||
          !(await dependencies.store.isTriageEligible(ticket.id))
        )
          return false;
        if (
          !(await dependencies.store.claimReporterMessage(
            ticket.id,
            message.id,
          ))
        )
          return true;
        const next = (queues.get(ticket.id) ?? Promise.resolve()).then(() =>
          process(message, ticket.id),
        );
        const safe = next.catch((error: unknown) => {
          warn(
            error instanceof OpenRouterError
              ? error.kind
              : error instanceof ModelCredentialError
                ? "credential_error"
                : "failed",
          );
        });
        queues.set(ticket.id, safe);
        await safe;
        if (queues.get(ticket.id) === safe) queues.delete(ticket.id);
        return true;
      } catch {
        warn("failed");
        return false;
      }
    },
  });
};
