import type {
  Authorize,
  Awaitable,
  DispatchOutcome,
  DispatchResult,
  TriggerDefinition,
  TriggerProvider,
} from "./contracts.js";
import type { ActionRegistry } from "./registry.js";

export const TEXT_COMMAND_PROVIDER_ID = "discord-text-command";

export type TextCommandTrigger<
  Input = string,
  Context = unknown,
> = TriggerDefinition<Input, Context> &
  Readonly<{
    providerId: typeof TEXT_COMMAND_PROVIDER_ID;
    parseText?: (argumentTail: string, message: TextCommandMessage) => Input;
    presentText?: PresentTextCommand<Context>;
  }>;

export type TextCommandMessage = Readonly<{
  content: string;
  author: Readonly<{
    id: string;
    username: string;
    globalName?: string | null;
    bot: boolean;
  }>;
  webhookId?: string | null;
  channelId: string;
  guildId?: string | null;
}>;

export type PresentTextCommand<Context> = (
  trigger: TextCommandTrigger<unknown, Context>,
  message: TextCommandMessage,
  outcome: DispatchOutcome,
  context: Context,
) => Awaitable<void>;

export type TextCommandProviderOptions<Context> = Readonly<{
  prefix?: string;
  present?: PresentTextCommand<Context>;
}>;

export type TextCommandProvider<Context> = TriggerProvider<
  Context,
  TextCommandTrigger<unknown, Context>,
  TextCommandMessage
> &
  Readonly<{
    prefix: string | undefined;
  }>;

export type DispatchTextCommandRequest<Context, AuthorizationCheck> = Readonly<{
  registry: ActionRegistry<Context, AuthorizationCheck>;
  provider: TextCommandProvider<Context>;
  message: TextCommandMessage;
  context: Context;
  authorize?: Authorize<Context, AuthorizationCheck>;
}>;

export type TextCommandDispatchResult =
  | Readonly<{ consumed: false }>
  | Readonly<{
      consumed: true;
      result: Extract<DispatchResult, { matched: true }>;
    }>;

export function textCommandTrigger<Input = string, Context = unknown>(input: {
  name: string;
  description: string;
  usage?: string;
  parse?: (argumentTail: string, message: TextCommandMessage) => Input;
  present?: PresentTextCommand<Context>;
}): TextCommandTrigger<Input, Context> {
  if (input.name.length === 0 || /\s/u.test(input.name)) {
    throw new TypeError("Text command name must be one non-whitespace token");
  }
  return {
    providerId: TEXT_COMMAND_PROVIDER_ID,
    name: input.name,
    description: input.description,
    usage: input.usage ?? input.name,
    ...(input.parse ? { parseText: input.parse } : {}),
    ...(input.present ? { presentText: input.present } : {}),
  };
}

export function createTextCommandProvider<Context>(
  options: TextCommandProviderOptions<Context> = {},
): TextCommandProvider<Context> {
  const prefix = normalizePrefix(options.prefix);

  return {
    id: TEXT_COMMAND_PROVIDER_ID,
    prefix,
    isTrigger: (trigger): trigger is TextCommandTrigger<unknown, Context> =>
      trigger.providerId === TEXT_COMMAND_PROVIDER_ID,
    isEvent: (event): event is TextCommandMessage =>
      isTextCommandMessage(event),
    getTriggerKey: (trigger) =>
      prefix === undefined ? undefined : trigger.name,
    normalizeLookupKey: (key) => key.toLowerCase(),
    parse: (trigger, message) => {
      const argumentTail = parseMessage(message, prefix)?.argumentTail;
      return argumentTail === undefined
        ? undefined
        : trigger.parseText
          ? trigger.parseText(argumentTail, message)
          : argumentTail;
    },
    getInvocationDetails: (_trigger, message) => ({
      source: TEXT_COMMAND_PROVIDER_ID,
      channelId: message.channelId,
      ...(message.guildId === undefined || message.guildId === null
        ? {}
        : { guildId: message.guildId }),
      requester: {
        id: message.author.id,
        name: message.author.globalName ?? message.author.username,
      },
    }),
    present: async (trigger, message, outcome, context) => {
      await (trigger.presentText ?? options.present)?.(
        trigger,
        message,
        outcome,
        context,
      );
    },
  };
}

export async function dispatchTextCommand<Context, AuthorizationCheck>(
  request: DispatchTextCommandRequest<Context, AuthorizationCheck>,
): Promise<TextCommandDispatchResult> {
  if (request.registry.getProvider(request.provider.id) !== request.provider) {
    throw new Error(
      "Text command provider is not registered with this registry",
    );
  }
  if (request.message.author.bot || request.message.webhookId) {
    return { consumed: false };
  }

  const parsed = parseMessage(request.message, request.provider.prefix);
  if (!parsed) {
    return { consumed: false };
  }

  const result = await request.registry.dispatch({
    providerId: request.provider.id,
    triggerName: parsed.commandName,
    event: request.message,
    context: request.context,
    ...(request.authorize === undefined
      ? {}
      : { authorize: request.authorize }),
  });

  return result.matched ? { consumed: true, result } : { consumed: false };
}

function isTextCommandMessage(event: unknown): event is TextCommandMessage {
  if (!event || typeof event !== "object") {
    return false;
  }
  const message = event as Partial<TextCommandMessage>;
  return (
    typeof message.content === "string" &&
    typeof message.channelId === "string" &&
    Boolean(message.author) &&
    typeof message.author?.id === "string" &&
    typeof message.author.username === "string" &&
    typeof message.author.bot === "boolean"
  );
}

function normalizePrefix(
  configuredPrefix: string | undefined,
): string | undefined {
  const prefix = configuredPrefix === undefined ? "!" : configuredPrefix.trim();
  if (prefix.length === 0) {
    return undefined;
  }

  const codePointLength = [...prefix].length;
  if (codePointLength > 8) {
    throw new RangeError(
      "Text command prefix must contain 1-8 Unicode code points",
    );
  }
  return prefix;
}

function parseMessage(
  message: TextCommandMessage,
  prefix: string | undefined,
): Readonly<{ commandName: string; argumentTail: string }> | undefined {
  if (prefix === undefined || !message.content.startsWith(prefix)) {
    return undefined;
  }

  const commandAndArguments = message.content.slice(prefix.length);
  const match = /^\s*(\S+)([\s\S]*)$/u.exec(commandAndArguments);
  if (!match) {
    return undefined;
  }

  const commandName = match[1];
  const argumentTail = match[2];
  if (commandName === undefined || argumentTail === undefined) {
    return undefined;
  }

  return { commandName: commandName.toLowerCase(), argumentTail };
}
