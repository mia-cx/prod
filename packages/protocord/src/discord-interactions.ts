import {
  ApplicationCommandType,
  MessageFlags,
  type ApplicationCommandData,
  type ApplicationCommandOptionChoiceData,
  type ApplicationCommandOptionData,
  type AutocompleteInteraction,
  type ChatInputApplicationCommandData,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type InteractionReplyOptions,
  type MessageApplicationCommandData,
  type MessageContextMenuCommandInteraction,
  type UserApplicationCommandData,
  type UserContextMenuCommandInteraction,
} from "discord.js";

import type {
  ActionAvailability,
  ActionInvocation,
  Authorize,
  Awaitable,
  DispatchOutcome,
  DispatchResult,
  TriggerDefinition,
  TriggerProvider,
} from "./contracts.js";
import type { ActionRegistry } from "./registry.js";

export const discordSlashCommandProviderId = "discord:slash-command";
export const discordMessageContextProviderId = "discord:message-context";
export const discordUserContextProviderId = "discord:user-context";

const NO_MENTIONS: NonNullable<InteractionReplyOptions["allowedMentions"]> = {
  parse: [],
  repliedUser: false,
};

type DiscordPresentation<InteractionType, Context> = (
  outcome: DispatchOutcome,
  interaction: InteractionType,
  context: Context,
) => Awaitable<void>;

export type DiscordAcknowledgement = "defer" | "none";
export type DiscordResponseVisibility = "ephemeral" | "public";

export type DiscordAutocompleteAccess<Context, AuthorizationCheck> =
  | Readonly<{ kind: "public" }>
  | Readonly<{
      kind: "authorized";
      authorization: (
        interaction: AutocompleteInteraction,
        context: Context,
      ) => Awaitable<AuthorizationCheck>;
    }>;

export type DiscordAutocomplete<Context, AuthorizationCheck> = Readonly<{
  /** Public, invocation-independent availability checked before access. */
  availability: (context: Context) => Awaitable<ActionAvailability>;
  access: DiscordAutocompleteAccess<Context, AuthorizationCheck>;
  /** Interaction-sensitive readiness checked only after access succeeds. */
  readiness?: (
    interaction: AutocompleteInteraction,
    context: Context,
  ) => Awaitable<ActionAvailability>;
  complete: (
    interaction: AutocompleteInteraction,
    context: Context,
  ) => Awaitable<readonly ApplicationCommandOptionChoiceData[]>;
}>;

type SlashCommandRegistration = Omit<
  ChatInputApplicationCommandData,
  "description" | "name" | "options" | "type"
>;

type MessageContextRegistration = Omit<
  MessageApplicationCommandData,
  "name" | "type"
>;
type UserContextRegistration = Omit<
  UserApplicationCommandData,
  "name" | "type"
>;

export type SlashCommandTrigger<
  Input,
  Context = unknown,
  AuthorizationCheck = never,
> = TriggerDefinition<Input> &
  Readonly<{
    providerId: typeof discordSlashCommandProviderId;
    options: readonly ApplicationCommandOptionData[];
    registration: SlashCommandRegistration;
    acknowledgement: DiscordAcknowledgement;
    visibility: DiscordResponseVisibility;
    parseInteraction(interaction: ChatInputCommandInteraction): Input;
    autocomplete?: DiscordAutocomplete<Context, AuthorizationCheck>;
    presentInteraction?: DiscordPresentation<
      ChatInputCommandInteraction,
      Context
    >;
  }>;

export type MessageContextMenuTrigger<
  Input,
  Context = unknown,
> = TriggerDefinition<Input> &
  Readonly<{
    providerId: typeof discordMessageContextProviderId;
    registration: MessageContextRegistration;
    acknowledgement: DiscordAcknowledgement;
    visibility: DiscordResponseVisibility;
    parseInteraction(interaction: MessageContextMenuCommandInteraction): Input;
    presentInteraction?: DiscordPresentation<
      MessageContextMenuCommandInteraction,
      Context
    >;
  }>;

export type UserContextMenuTrigger<
  Input,
  Context = unknown,
> = TriggerDefinition<Input> &
  Readonly<{
    providerId: typeof discordUserContextProviderId;
    registration: UserContextRegistration;
    acknowledgement: DiscordAcknowledgement;
    visibility: DiscordResponseVisibility;
    parseInteraction(interaction: UserContextMenuCommandInteraction): Input;
    presentInteraction?: DiscordPresentation<
      UserContextMenuCommandInteraction,
      Context
    >;
  }>;

export function slashCommand<
  Input,
  Context = unknown,
  AuthorizationCheck = never,
>(input: {
  name: string;
  description: string;
  usage?: string;
  options?: readonly ApplicationCommandOptionData[];
  registration?: SlashCommandRegistration;
  acknowledgement?: DiscordAcknowledgement;
  visibility?: DiscordResponseVisibility;
  parse: (interaction: ChatInputCommandInteraction) => Input;
  autocomplete?: DiscordAutocomplete<Context, AuthorizationCheck>;
  present?: DiscordPresentation<ChatInputCommandInteraction, Context>;
}): SlashCommandTrigger<Input, Context, AuthorizationCheck> {
  return {
    providerId: discordSlashCommandProviderId,
    name: input.name,
    description: input.description,
    usage: input.usage ?? `/${input.name}`,
    options: input.options ?? [],
    registration: input.registration ?? {},
    acknowledgement: input.acknowledgement ?? "defer",
    visibility: input.visibility ?? "ephemeral",
    parseInteraction: input.parse,
    ...(input.autocomplete ? { autocomplete: input.autocomplete } : {}),
    ...(input.present ? { presentInteraction: input.present } : {}),
  };
}

export function messageContextMenu<Input, Context = unknown>(input: {
  name: string;
  description?: string;
  usage?: string;
  registration?: MessageContextRegistration;
  acknowledgement?: DiscordAcknowledgement;
  visibility?: DiscordResponseVisibility;
  parse: (interaction: MessageContextMenuCommandInteraction) => Input;
  present?: DiscordPresentation<MessageContextMenuCommandInteraction, Context>;
}): MessageContextMenuTrigger<Input, Context> {
  return {
    providerId: discordMessageContextProviderId,
    name: input.name,
    description: input.description ?? input.name,
    usage: input.usage ?? input.name,
    registration: input.registration ?? {},
    acknowledgement: input.acknowledgement ?? "defer",
    visibility: input.visibility ?? "ephemeral",
    parseInteraction: input.parse,
    ...(input.present ? { presentInteraction: input.present } : {}),
  };
}

export function userContextMenu<Input, Context = unknown>(input: {
  name: string;
  description?: string;
  usage?: string;
  registration?: UserContextRegistration;
  acknowledgement?: DiscordAcknowledgement;
  visibility?: DiscordResponseVisibility;
  parse: (interaction: UserContextMenuCommandInteraction) => Input;
  present?: DiscordPresentation<UserContextMenuCommandInteraction, Context>;
}): UserContextMenuTrigger<Input, Context> {
  return {
    providerId: discordUserContextProviderId,
    name: input.name,
    description: input.description ?? input.name,
    usage: input.usage ?? input.name,
    registration: input.registration ?? {},
    acknowledgement: input.acknowledgement ?? "defer",
    visibility: input.visibility ?? "ephemeral",
    parseInteraction: input.parse,
    ...(input.present ? { presentInteraction: input.present } : {}),
  };
}

export function createDiscordSlashCommandProvider<
  Context,
>(): TriggerProvider<Context> {
  return createDiscordCommandProvider(
    discordSlashCommandProviderId,
    "discord:slash-command",
    (trigger, interaction) =>
      asSlashTrigger<Context>(trigger).parseInteraction(
        interaction as ChatInputCommandInteraction,
      ),
    async (trigger, interaction, outcome, context) => {
      const slashTrigger = asSlashTrigger<Context>(trigger);
      const commandInteraction = interaction as ChatInputCommandInteraction;
      if (slashTrigger.presentInteraction) {
        await slashTrigger.presentInteraction(
          outcome,
          commandInteraction,
          context,
        );
      } else {
        await presentDiscordOutcome(
          outcome,
          commandInteraction,
          slashTrigger.visibility,
        );
      }
    },
  );
}

export function createDiscordMessageContextProvider<
  Context,
>(): TriggerProvider<Context> {
  return createDiscordCommandProvider(
    discordMessageContextProviderId,
    "discord:message-context",
    (trigger, interaction) =>
      asMessageTrigger<Context>(trigger).parseInteraction(
        interaction as MessageContextMenuCommandInteraction,
      ),
    async (trigger, interaction, outcome, context) => {
      const messageTrigger = asMessageTrigger<Context>(trigger);
      const commandInteraction =
        interaction as MessageContextMenuCommandInteraction;
      if (messageTrigger.presentInteraction) {
        await messageTrigger.presentInteraction(
          outcome,
          commandInteraction,
          context,
        );
      } else {
        await presentDiscordOutcome(
          outcome,
          commandInteraction,
          messageTrigger.visibility,
        );
      }
    },
  );
}

export function createDiscordUserContextProvider<
  Context,
>(): TriggerProvider<Context> {
  return createDiscordCommandProvider(
    discordUserContextProviderId,
    "discord:user-context",
    (trigger, interaction) =>
      asUserTrigger<Context>(trigger).parseInteraction(
        interaction as UserContextMenuCommandInteraction,
      ),
    async (trigger, interaction, outcome, context) => {
      const userTrigger = asUserTrigger<Context>(trigger);
      const commandInteraction =
        interaction as UserContextMenuCommandInteraction;
      if (userTrigger.presentInteraction) {
        await userTrigger.presentInteraction(
          outcome,
          commandInteraction,
          context,
        );
      } else {
        await presentDiscordOutcome(
          outcome,
          commandInteraction,
          userTrigger.visibility,
        );
      }
    },
  );
}

export function createDiscordInteractionProviders<
  Context,
>(): readonly TriggerProvider<Context>[] {
  return [
    createDiscordSlashCommandProvider<Context>(),
    createDiscordMessageContextProvider<Context>(),
    createDiscordUserContextProvider<Context>(),
  ];
}

export async function dispatchDiscordInteraction<
  Context,
  AuthorizationCheck = never,
>(
  registry: ActionRegistry<Context, AuthorizationCheck>,
  interaction: Interaction,
  context: Context,
  authorize?: Authorize<Context, AuthorizationCheck>,
): Promise<DispatchResult> {
  const providerId = getInteractionProviderId(interaction);
  if (!providerId) {
    return { matched: false };
  }
  const commandInteraction = interaction as
    | ChatInputCommandInteraction
    | MessageContextMenuCommandInteraction
    | UserContextMenuCommandInteraction;
  const registered = registry.getTrigger(
    providerId,
    commandInteraction.commandName,
  );
  if (!registered) {
    return { matched: false };
  }

  const acknowledgement = getAcknowledgement(registered.trigger);
  if (
    acknowledgement !== "none" &&
    !commandInteraction.deferred &&
    !commandInteraction.replied
  ) {
    await commandInteraction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  return registry.dispatch({
    providerId,
    triggerName: commandInteraction.commandName,
    event: interaction,
    context,
    ...(authorize ? { authorize } : {}),
  });
}

export async function dispatchDiscordAutocomplete<
  Context,
  AuthorizationCheck = never,
>(
  registry: ActionRegistry<Context, AuthorizationCheck>,
  interaction: Interaction,
  context: Context,
  authorize?: Authorize<Context, AuthorizationCheck>,
): Promise<boolean> {
  if (!interaction.isAutocomplete()) {
    return false;
  }

  const registered = registry.getTrigger(
    discordSlashCommandProviderId,
    interaction.commandName,
  );
  if (!registered) {
    return false;
  }

  const trigger = asSlashTrigger<Context, AuthorizationCheck>(
    registered.trigger,
  );
  const autocomplete = trigger.autocomplete;
  if (!autocomplete) {
    return false;
  }

  const failAutocomplete = async (error: unknown): Promise<never> => {
    try {
      await interaction.respond([]);
    } catch (responseError) {
      throw new AggregateError(
        [error, responseError],
        "Autocomplete failed and its empty fallback response also failed",
        { cause: error },
      );
    }
    throw error;
  };

  const runAutocompleteStep = async <Value>(
    step: () => Value | PromiseLike<Value>,
  ): Promise<Value> => {
    try {
      return await step();
    } catch (error) {
      return failAutocomplete(error);
    }
  };

  const availability = await runAutocompleteStep(() =>
    autocomplete.availability(context),
  );
  if (!availability.available) {
    await interaction.respond([]);
    return true;
  }

  const access = autocomplete.access;
  if (access.kind === "authorized") {
    if (!authorize) {
      return failAutocomplete(
        new Error(
          `Autocomplete for ${trigger.name} requires authorization but no authorizer was provided`,
        ),
      );
    }
    const check = await runAutocompleteStep(() =>
      access.authorization(interaction, context),
    );
    const invocation = autocompleteInvocation(interaction, trigger.name);
    const decision = await runAutocompleteStep(() =>
      authorize(check, invocation, context),
    );
    if (!decision.authorized) {
      await interaction.respond([]);
      return true;
    }
  }

  const readinessCheck = autocomplete.readiness;
  const readiness = readinessCheck
    ? await runAutocompleteStep(() => readinessCheck(interaction, context))
    : undefined;
  if (readiness && !readiness.available) {
    await interaction.respond([]);
    return true;
  }

  const choices = await runAutocompleteStep(() =>
    autocomplete.complete(interaction, context),
  );
  await interaction.respond(choices);
  return true;
}

export type DiscordInteractionHandleResult =
  | Readonly<{ handled: false }>
  | Readonly<{ handled: true; type: "autocomplete" }>
  | Readonly<{
      handled: true;
      type: "command";
      result: DispatchResult & { matched: true };
    }>;

export async function handleDiscordInteraction<
  Context,
  AuthorizationCheck = never,
>(
  registry: ActionRegistry<Context, AuthorizationCheck>,
  interaction: Interaction,
  context: Context,
  authorize?: Authorize<Context, AuthorizationCheck>,
): Promise<DiscordInteractionHandleResult> {
  if (interaction.isAutocomplete()) {
    return (await dispatchDiscordAutocomplete(
      registry,
      interaction,
      context,
      authorize,
    ))
      ? { handled: true, type: "autocomplete" }
      : { handled: false };
  }

  const result = await dispatchDiscordInteraction(
    registry,
    interaction,
    context,
    authorize,
  );
  return result.matched
    ? { handled: true, type: "command", result }
    : { handled: false };
}

export function getDiscordCommandRegistration<Context, AuthorizationCheck>(
  registry: ActionRegistry<Context, AuthorizationCheck>,
): readonly ApplicationCommandData[] {
  const slashCommands = registry
    .getTriggers(discordSlashCommandProviderId)
    .map(({ trigger }) => {
      const slashTrigger = asSlashTrigger<Context>(trigger);
      return {
        ...slashTrigger.registration,
        type: ApplicationCommandType.ChatInput,
        name: slashTrigger.name,
        description: slashTrigger.description,
        options: slashTrigger.options,
      } satisfies ChatInputApplicationCommandData;
    });
  const messageCommands = registry
    .getTriggers(discordMessageContextProviderId)
    .map(({ trigger }) => {
      const messageTrigger = asMessageTrigger<Context>(trigger);
      return {
        ...messageTrigger.registration,
        type: ApplicationCommandType.Message,
        name: messageTrigger.name,
      } satisfies MessageApplicationCommandData;
    });
  const userCommands = registry
    .getTriggers(discordUserContextProviderId)
    .map(({ trigger }) => {
      const userTrigger = asUserTrigger<Context>(trigger);
      return {
        ...userTrigger.registration,
        type: ApplicationCommandType.User,
        name: userTrigger.name,
      } satisfies UserApplicationCommandData;
    });

  return [...slashCommands, ...messageCommands, ...userCommands];
}

export type DiscordCommandRegistrationTarget =
  | Readonly<{ kind: "global" }>
  | Readonly<{
      kind: "guild";
      guildId: string;
    }>;

export async function registerDiscordCommands<Context, AuthorizationCheck>(
  client: Client<true>,
  registry: ActionRegistry<Context, AuthorizationCheck>,
  options?: Readonly<{
    target?: DiscordCommandRegistrationTarget;
  }>,
): Promise<void> {
  const commands = getDiscordCommandRegistration(registry);
  const target = options?.target ?? { kind: "global" };

  // Registration targets are exclusive. Discord displays both entries when the
  // same command exists globally and in a guild, so clear the opposite catalog
  // before publishing the authoritative one.
  if (target.kind === "guild") {
    const guild =
      client.guilds.cache.get(target.guildId) ??
      (await client.guilds.fetch(target.guildId));
    await client.application.commands.set([]);
    await guild.commands.set(commands);
    return;
  }

  await Promise.all(
    [...client.guilds.cache.values()].map((guild) => guild.commands.set([])),
  );
  await client.application.commands.set(commands);
}

function createDiscordCommandProvider<Context>(
  id: string,
  source: string,
  parse: (trigger: TriggerDefinition<unknown>, interaction: unknown) => unknown,
  present: (
    trigger: TriggerDefinition<unknown>,
    interaction: unknown,
    outcome: DispatchOutcome,
    context: Context,
  ) => Awaitable<void>,
): TriggerProvider<Context> {
  return {
    id,
    isTrigger: (trigger): trigger is TriggerDefinition<unknown> =>
      trigger.providerId === id &&
      typeof (
        trigger as TriggerDefinition<unknown> & {
          parseInteraction?: unknown;
        }
      ).parseInteraction === "function" &&
      isAcknowledgement(
        (
          trigger as TriggerDefinition<unknown> & {
            acknowledgement?: unknown;
          }
        ).acknowledgement,
      ) &&
      isResponseVisibility(
        (
          trigger as TriggerDefinition<unknown> & {
            visibility?: unknown;
          }
        ).visibility,
      ),
    isEvent: (event): event is unknown => isDiscordProviderEvent(id, event),
    getTriggerKey: (trigger) => trigger.name,
    normalizeLookupKey: (key) => key.toLocaleLowerCase("en-US"),
    parse,
    getInvocationDetails: (_trigger, event) => {
      const interaction = event as ChatInputCommandInteraction;
      return {
        source,
        ...(interaction.channelId ? { channelId: interaction.channelId } : {}),
        ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
        requester: {
          id: interaction.user.id,
          name: interaction.user.globalName ?? interaction.user.username,
        },
      };
    },
    present,
  };
}

function getAcknowledgement(
  trigger: TriggerDefinition<unknown>,
): DiscordAcknowledgement {
  return (
    trigger as TriggerDefinition<unknown> & {
      acknowledgement: DiscordAcknowledgement;
    }
  ).acknowledgement;
}

function isAcknowledgement(value: unknown): value is DiscordAcknowledgement {
  return value === "defer" || value === "none";
}

function isResponseVisibility(
  value: unknown,
): value is DiscordResponseVisibility {
  return value === "ephemeral" || value === "public";
}

function isDiscordProviderEvent(
  id: string,
  event: unknown,
): event is Interaction {
  if (!event || typeof event !== "object") {
    return false;
  }
  const interaction = event as Partial<Interaction> & {
    user?: { id?: unknown; username?: unknown };
  };
  if (
    typeof interaction.user?.id !== "string" ||
    typeof interaction.user.username !== "string"
  ) {
    return false;
  }
  if (
    id === discordSlashCommandProviderId &&
    typeof interaction.isChatInputCommand === "function"
  ) {
    return interaction.isChatInputCommand();
  }
  if (
    id === discordMessageContextProviderId &&
    typeof interaction.isMessageContextMenuCommand === "function"
  ) {
    return interaction.isMessageContextMenuCommand();
  }
  if (
    id === discordUserContextProviderId &&
    typeof interaction.isUserContextMenuCommand === "function"
  ) {
    return interaction.isUserContextMenuCommand();
  }
  return false;
}

function autocompleteInvocation(
  interaction: AutocompleteInteraction,
  triggerName: string,
): ActionInvocation<unknown> {
  return {
    source: discordSlashCommandProviderId,
    triggerName,
    input: undefined,
    rawEvent: interaction,
    channelId: interaction.channelId,
    ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
    requester: {
      id: interaction.user.id,
      name: interaction.user.globalName ?? interaction.user.username,
    },
  };
}

function getInteractionProviderId(
  interaction: Interaction,
):
  | typeof discordSlashCommandProviderId
  | typeof discordMessageContextProviderId
  | typeof discordUserContextProviderId
  | undefined {
  if (interaction.isChatInputCommand()) return discordSlashCommandProviderId;
  if (interaction.isMessageContextMenuCommand())
    return discordMessageContextProviderId;
  if (interaction.isUserContextMenuCommand())
    return discordUserContextProviderId;
  return undefined;
}

async function presentDiscordOutcome(
  outcome: DispatchOutcome,
  interaction:
    | ChatInputCommandInteraction
    | MessageContextMenuCommandInteraction
    | UserContextMenuCommandInteraction,
  visibility: DiscordResponseVisibility,
): Promise<void> {
  if (outcome.status === "executed" && visibility === "public") {
    const reply = {
      content: formatOutput(outcome.output),
      allowedMentions: NO_MENTIONS,
    };
    if (interaction.deferred) {
      await interaction.deleteReply();
      await interaction.followUp(reply);
    } else if (interaction.replied) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
    return;
  }

  const reply = outcomeReply(outcome);
  if (interaction.deferred) {
    await interaction.editReply({
      content: reply.content,
      allowedMentions: reply.allowedMentions,
    });
  } else if (interaction.replied) {
    await interaction.followUp(reply);
  } else {
    await interaction.reply(reply);
  }
}

function outcomeReply(outcome: DispatchOutcome): InteractionReplyOptions & {
  content: string;
  allowedMentions: NonNullable<InteractionReplyOptions["allowedMentions"]>;
} {
  switch (outcome.status) {
    case "executed":
      return {
        content: formatOutput(outcome.output),
        allowedMentions: NO_MENTIONS,
        flags: MessageFlags.Ephemeral,
      };
    case "unavailable":
    case "unauthorized":
      return {
        content: outcome.reason,
        allowedMentions: NO_MENTIONS,
        flags: MessageFlags.Ephemeral,
      };
    case "failed":
      return {
        content: "Something went wrong while running this action.",
        allowedMentions: NO_MENTIONS,
        flags: MessageFlags.Ephemeral,
      };
  }
}

function formatOutput(output: unknown): string {
  if (output === undefined) return "Done.";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

function asSlashTrigger<Context, AuthorizationCheck = never>(
  trigger: TriggerDefinition<unknown>,
): SlashCommandTrigger<unknown, Context, AuthorizationCheck> {
  return trigger as SlashCommandTrigger<unknown, Context, AuthorizationCheck>;
}

function asMessageTrigger<Context>(
  trigger: TriggerDefinition<unknown>,
): MessageContextMenuTrigger<unknown, Context> {
  return trigger as MessageContextMenuTrigger<unknown, Context>;
}

function asUserTrigger<Context>(
  trigger: TriggerDefinition<unknown>,
): UserContextMenuTrigger<unknown, Context> {
  return trigger as UserContextMenuTrigger<unknown, Context>;
}
