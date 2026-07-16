import {
  ComponentType,
  MessageFlags,
  TextInputStyle,
  type APILabelComponent,
  type APIMessageTopLevelComponent,
  type APIModalInteractionResponseCallbackData,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type MentionableSelectMenuInteraction,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";

import type {
  Awaitable,
  SettingsAuthorizationDecision,
  SettingsCategory,
  SettingsChannel,
  SettingsDefinition,
  SettingsField,
  SettingsMentionable,
  SettingsModalField,
  SettingsMutationCallbackResult,
  SettingsMutationResult,
  SettingsSubcategory,
  SettingsValidationIssue,
} from "./contracts.js";
import {
  createSettingsRenderer,
  SettingsViewError,
  type SettingsRenderer,
  type SettingsViewNotice,
  type SettingsViewRequest,
} from "./render.js";
import {
  decodeSettingsCustomId,
  encodeSettingsCustomId,
  isSettingsCustomId,
  type SettingsRoute,
} from "./routes.js";

const NO_MENTIONS: NonNullable<InteractionReplyOptions["allowedMentions"]> = {
  parse: [],
  repliedUser: false,
};

export type SettingsDispatchStatus =
  | "opened"
  | "viewed"
  | "modal-shown"
  | "mutated"
  | "validation-failed"
  | "unauthorized"
  | "stale"
  | "failed";

export type SettingsDispatchResult =
  | Readonly<{ matched: false }>
  | Readonly<{ matched: true; status: SettingsDispatchStatus }>;

export type SettingsRuntimeOptions<Context> = Readonly<{
  definition: SettingsDefinition<Context>;
  onError?: (
    error: unknown,
    interaction: RepliableInteraction,
    context: Context,
  ) => Awaitable<void>;
}>;

export type SettingsRuntime<Context> = Readonly<{
  open(
    interaction: RepliableInteraction,
    context: Context,
    request?: SettingsViewRequest,
  ): Promise<SettingsDispatchResult>;
  matches(interaction: Interaction): boolean;
  handle(
    interaction: Interaction,
    context: Context,
  ): Promise<SettingsDispatchResult>;
}>;

type SettingsComponentInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | MentionableSelectMenuInteraction
  | ChannelSelectMenuInteraction
  | ModalSubmitInteraction;

type ResolvedRoute<Context> = Readonly<{
  route: SettingsRoute;
  category: SettingsCategory<Context>;
  subcategory: SettingsSubcategory<Context>;
  field?: SettingsField<Context>;
}>;

export function createSettingsRuntime<Context>(
  options: SettingsRuntimeOptions<Context>,
): SettingsRuntime<Context> {
  const renderer = createSettingsRenderer(options.definition);
  const drafts = new Map<string, Readonly<Record<string, string>>>();

  return Object.freeze({
    open: (interaction, context, request = {}) =>
      openSettings(renderer, interaction, context, request, options.onError),
    matches: (interaction) => {
      const component = asSettingsComponent(interaction);
      return component !== undefined && isSettingsCustomId(component.customId);
    },
    handle: (interaction, context) =>
      handleSettingsInteraction(
        options.definition,
        renderer,
        drafts,
        interaction,
        context,
        options.onError,
      ),
  });
}

async function openSettings<Context>(
  renderer: SettingsRenderer<Context>,
  interaction: RepliableInteraction,
  context: Context,
  request: SettingsViewRequest,
  onError: SettingsRuntimeOptions<Context>["onError"],
): Promise<SettingsDispatchResult> {
  try {
    const view = await renderer.render(request, context);
    await interaction.reply(replyView(view.components));
    return { matched: true, status: "opened" };
  } catch (error) {
    if (error instanceof SettingsViewError) {
      if (error.reason === "unauthorized") {
        await respondEphemeral(interaction, error.message);
        return { matched: true, status: "unauthorized" };
      }
      if (error.reason === "stale") {
        await respondEphemeral(interaction, staleMessage());
        return { matched: true, status: "stale" };
      }
    }
    await reportError(onError, error, interaction, context);
    await respondEphemeral(interaction, failureMessage());
    return { matched: true, status: "failed" };
  }
}

async function handleSettingsInteraction<Context>(
  definition: SettingsDefinition<Context>,
  renderer: SettingsRenderer<Context>,
  drafts: Map<string, Readonly<Record<string, string>>>,
  interaction: Interaction,
  context: Context,
  onError: SettingsRuntimeOptions<Context>["onError"],
): Promise<SettingsDispatchResult> {
  const component = asSettingsComponent(interaction);
  if (component === undefined || !isSettingsCustomId(component.customId)) {
    return { matched: false };
  }
  const decoded = decodeSettingsCustomId(component.customId);
  if (!decoded.ok) {
    await respondEphemeral(component, staleMessage());
    return { matched: true, status: "stale" };
  }
  const resolved = resolveRoute(definition, decoded.route);
  if (resolved === undefined) {
    await respondEphemeral(component, staleMessage());
    return { matched: true, status: "stale" };
  }

  try {
    switch (resolved.route.action) {
      case "category":
        if (!component.isStringSelectMenu()) {
          return staleInteraction(component);
        }
        return await navigateCategory(renderer, resolved, component, context);
      case "subcategory":
        if (!component.isStringSelectMenu()) {
          return staleInteraction(component);
        }
        return await navigateSubcategory(renderer, resolved, component, context);
      case "page":
        if (!component.isButton()) {
          return staleInteraction(component);
        }
        return await updateView(
          renderer,
          component,
          context,
          routeRequest(resolved.route),
          "viewed",
        );
      case "modal":
        if (!component.isButton()) {
          return staleInteraction(component);
        }
        return await showSettingsModal(
          resolved,
          component,
          drafts,
          context,
        );
      case "button":
        if (!component.isButton()) {
          return staleInteraction(component);
        }
        return await mutateButton(renderer, resolved, component, context);
      case "string-select":
        if (!component.isStringSelectMenu()) {
          return staleInteraction(component);
        }
        return await mutateStringSelect(renderer, resolved, component, context);
      case "mentionable-select":
        if (!component.isMentionableSelectMenu()) {
          return staleInteraction(component);
        }
        return await mutateMentionables(renderer, resolved, component, context);
      case "channel-select":
        if (!component.isChannelSelectMenu()) {
          return staleInteraction(component);
        }
        return await mutateChannels(renderer, resolved, component, context);
      case "modal-submit":
        if (!component.isModalSubmit()) {
          return staleInteraction(component);
        }
        return await submitModal(
          renderer,
          resolved,
          component,
          drafts,
          context,
        );
    }
  } catch (error) {
    if (error instanceof SettingsViewError) {
      if (error.reason === "unauthorized") {
        await respondEphemeral(component, error.message);
        return { matched: true, status: "unauthorized" };
      }
      if (error.reason === "stale") {
        await respondEphemeral(component, staleMessage());
        return { matched: true, status: "stale" };
      }
    }
    await reportError(onError, error, component, context);
    await respondEphemeral(component, failureMessage());
    return { matched: true, status: "failed" };
  }
}

async function navigateCategory<Context>(
  renderer: SettingsRenderer<Context>,
  _resolved: ResolvedRoute<Context>,
  interaction: StringSelectMenuInteraction,
  context: Context,
): Promise<SettingsDispatchResult> {
  const categoryId = singleSelectedValue(interaction);
  return updateView(
    renderer,
    interaction,
    context,
    { categoryId, page: 0 },
    "viewed",
  );
}

async function navigateSubcategory<Context>(
  renderer: SettingsRenderer<Context>,
  resolved: ResolvedRoute<Context>,
  interaction: StringSelectMenuInteraction,
  context: Context,
): Promise<SettingsDispatchResult> {
  const subcategoryId = singleSelectedValue(interaction);
  return updateView(
    renderer,
    interaction,
    context,
    { categoryId: resolved.category.id, subcategoryId, page: 0 },
    "viewed",
  );
}

async function showSettingsModal<Context>(
  resolved: ResolvedRoute<Context>,
  interaction: ButtonInteraction,
  drafts: Map<string, Readonly<Record<string, string>>>,
  context: Context,
): Promise<SettingsDispatchResult> {
  await requireAuthorization(resolved.category, context);
  const field = resolved.field as SettingsModalField<Context>;
  const view = await field.load(context);
  if (view.disabled === true) {
    throw new SettingsViewError("stale", "settings modal is disabled");
  }
  const draft = drafts.get(draftKey(interaction.user.id, resolved.route));
  const values = draft ?? view.values ?? {};
  await interaction.showModal({
    custom_id: encodeSettingsCustomId({
      ...resolved.route,
      action: "modal-submit",
    }),
    title: field.title,
    components: field.inputs.map((input): APILabelComponent => ({
      type: ComponentType.Label,
      label: input.label,
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      component: {
        type: ComponentType.TextInput,
        custom_id: input.id,
        style: input.style ?? TextInputStyle.Short,
        ...(input.placeholder === undefined
          ? {}
          : { placeholder: input.placeholder }),
        ...(input.required === undefined ? {} : { required: input.required }),
        ...(input.minLength === undefined
          ? {}
          : { min_length: input.minLength }),
        ...(input.maxLength === undefined
          ? {}
          : { max_length: input.maxLength }),
        ...(values[input.id] === undefined ? {} : { value: values[input.id] }),
      },
    })),
  } satisfies APIModalInteractionResponseCallbackData);
  return { matched: true, status: "modal-shown" };
}

async function mutateButton<Context>(
  renderer: SettingsRenderer<Context>,
  resolved: ResolvedRoute<Context>,
  interaction: ButtonInteraction,
  context: Context,
): Promise<SettingsDispatchResult> {
  await requireAuthorization(resolved.category, context);
  const field = resolved.field;
  if (field?.kind !== "button") {
    throw new SettingsViewError("stale", "settings button is stale");
  }
  const view = await field.load(context);
  if (view.disabled === true) {
    throw new SettingsViewError("stale", "settings button is disabled");
  }
  const result = normalizeMutationResult(await field.mutate(context));
  return finishMutation(renderer, resolved, interaction, result, context);
}

async function mutateStringSelect<Context>(
  renderer: SettingsRenderer<Context>,
  resolved: ResolvedRoute<Context>,
  interaction: StringSelectMenuInteraction,
  context: Context,
): Promise<SettingsDispatchResult> {
  await requireAuthorization(resolved.category, context);
  const field = resolved.field;
  if (field?.kind !== "string-select") {
    throw new SettingsViewError("stale", "settings select is stale");
  }
  const view = await field.load(context);
  if (view.disabled === true) {
    throw new SettingsViewError("stale", "settings select is disabled");
  }
  const allowedValues = new Set(view.options.map(({ value }) => value));
  if (interaction.values.some((value) => !allowedValues.has(value))) {
    throw new SettingsViewError("stale", "settings option is stale");
  }
  const result = await validateAndMutate(
    interaction.values,
    context,
    field.validate,
    field.mutate,
  );
  return finishMutation(renderer, resolved, interaction, result, context);
}

async function mutateMentionables<Context>(
  renderer: SettingsRenderer<Context>,
  resolved: ResolvedRoute<Context>,
  interaction: MentionableSelectMenuInteraction,
  context: Context,
): Promise<SettingsDispatchResult> {
  await requireAuthorization(resolved.category, context);
  const field = resolved.field;
  if (field?.kind !== "mentionable-select") {
    throw new SettingsViewError("stale", "settings mentionable select is stale");
  }
  const view = await field.load(context);
  if (view.disabled === true) {
    throw new SettingsViewError(
      "stale",
      "settings mentionable select is disabled",
    );
  }
  const values = interaction.values.map((id): SettingsMentionable => {
    const user = interaction.users.get(id);
    if (user !== undefined) {
      return {
        kind: "user",
        id,
        user: {
          id: user.id,
          username: user.username,
          globalName: user.globalName,
        },
      };
    }
    const role = interaction.roles.get(id);
    if (role !== undefined) {
      return {
        kind: "role",
        id,
        role: { id: role.id, name: role.name },
      };
    }
    throw new SettingsViewError(
      "stale",
      `mentionable ${id} could not be resolved`,
    );
  });
  const result = await validateAndMutate(
    values,
    context,
    field.validate,
    field.mutate,
  );
  return finishMutation(renderer, resolved, interaction, result, context);
}

async function mutateChannels<Context>(
  renderer: SettingsRenderer<Context>,
  resolved: ResolvedRoute<Context>,
  interaction: ChannelSelectMenuInteraction,
  context: Context,
): Promise<SettingsDispatchResult> {
  await requireAuthorization(resolved.category, context);
  const field = resolved.field;
  if (field?.kind !== "channel-select") {
    throw new SettingsViewError("stale", "settings channel select is stale");
  }
  const view = await field.load(context);
  if (view.disabled === true) {
    throw new SettingsViewError(
      "stale",
      "settings channel select is disabled",
    );
  }
  const values = interaction.values.map((id): SettingsChannel => {
    const channel = interaction.channels.get(id);
    if (channel === undefined || !("name" in channel)) {
      throw new SettingsViewError(
        "stale",
        `channel ${id} could not be resolved`,
      );
    }
    return {
      id,
      channel: {
        id: channel.id,
        name: channel.name ?? channel.id,
        type: channel.type,
      },
    };
  });
  const result = await validateAndMutate(
    values,
    context,
    field.validate,
    field.mutate,
  );
  return finishMutation(renderer, resolved, interaction, result, context);
}

async function submitModal<Context>(
  renderer: SettingsRenderer<Context>,
  resolved: ResolvedRoute<Context>,
  interaction: ModalSubmitInteraction,
  drafts: Map<string, Readonly<Record<string, string>>>,
  context: Context,
): Promise<SettingsDispatchResult> {
  await requireAuthorization(resolved.category, context);
  const field = resolved.field;
  if (field?.kind !== "modal") {
    throw new SettingsViewError("stale", "settings modal is stale");
  }
  const values = Object.fromEntries(
    field.inputs.map((input) => [
      input.id,
      interaction.fields.getTextInputValue(input.id),
    ]),
  );
  const result = await validateAndMutate(
    values,
    context,
    field.validate,
    field.mutate,
  );
  const key = draftKey(interaction.user.id, resolved.route);
  if (result.status === "invalid") {
    rememberDraft(drafts, key, values);
  } else {
    drafts.delete(key);
  }
  return finishMutation(renderer, resolved, interaction, result, context);
}

async function validateAndMutate<Value, Context>(
  value: Value,
  context: Context,
  validate:
    | ((
        value: Value,
        context: Context,
      ) => Awaitable<readonly SettingsValidationIssue[]>)
    | undefined,
  mutate: (
    value: Value,
    context: Context,
  ) => Awaitable<SettingsMutationCallbackResult>,
): Promise<SettingsMutationResult> {
  const issues = validate === undefined ? [] : await validate(value, context);
  if (issues.length > 0) {
    return { status: "invalid", issues };
  }
  return normalizeMutationResult(await mutate(value, context));
}

async function finishMutation<Context>(
  renderer: SettingsRenderer<Context>,
  resolved: ResolvedRoute<Context>,
  interaction: SettingsComponentInteraction,
  result: SettingsMutationResult,
  context: Context,
): Promise<SettingsDispatchResult> {
  const field = resolved.field;
  const notice: SettingsViewNotice =
    result.status === "success"
      ? {
          kind: "success",
          message: result.message ?? `${field?.label ?? "Setting"} updated.`,
        }
      : { kind: "error", message: formatIssues(result.issues) };
  return updateView(
    renderer,
    interaction,
    context,
    { ...routeRequest(resolved.route), notice },
    result.status === "success" ? "mutated" : "validation-failed",
  );
}

async function updateView<Context>(
  renderer: SettingsRenderer<Context>,
  interaction: SettingsComponentInteraction,
  context: Context,
  request: SettingsViewRequest,
  status: "viewed" | "mutated" | "validation-failed",
): Promise<SettingsDispatchResult> {
  const view = await renderer.render(request, context);
  if (interaction.isModalSubmit()) {
    if (!interaction.isFromMessage()) {
      await respondEphemeral(interaction, "Reopen settings and try again.");
      return { matched: true, status: "stale" };
    }
    await interaction.update(updateViewPayload(view.components));
  } else {
    await interaction.update(updateViewPayload(view.components));
  }
  return { matched: true, status };
}

function resolveRoute<Context>(
  definition: SettingsDefinition<Context>,
  route: SettingsRoute,
): ResolvedRoute<Context> | undefined {
  const category = definition.categories.find(({ id }) => id === route.categoryId);
  const subcategory = category?.subcategories.find(
    ({ id }) => id === route.subcategoryId,
  );
  if (category === undefined || subcategory === undefined) {
    return undefined;
  }
  const field =
    route.fieldId === undefined
      ? undefined
      : subcategory.fields.find(({ id }) => id === route.fieldId);
  if (route.fieldId !== undefined && field === undefined) {
    return undefined;
  }
  return {
    route,
    category,
    subcategory,
    ...(field === undefined ? {} : { field }),
  };
}

async function requireAuthorization<Context>(
  category: SettingsCategory<Context>,
  context: Context,
): Promise<void> {
  const rawDecision = await category.authorize(context);
  const decision: SettingsAuthorizationDecision =
    typeof rawDecision === "boolean"
      ? { authorized: rawDecision }
      : rawDecision;
  if (!decision.authorized) {
    throw new SettingsViewError(
      "unauthorized",
      decision.reason ?? "You are not authorized to change this setting.",
    );
  }
}

function asSettingsComponent(
  interaction: Interaction,
): SettingsComponentInteraction | undefined {
  return interaction.isButton() ||
    interaction.isStringSelectMenu() ||
    interaction.isMentionableSelectMenu() ||
    interaction.isChannelSelectMenu() ||
    interaction.isModalSubmit()
    ? interaction
    : undefined;
}

function normalizeMutationResult(
  result: SettingsMutationCallbackResult,
): SettingsMutationResult {
  return result ?? { status: "success" };
}

function singleSelectedValue(interaction: StringSelectMenuInteraction): string {
  const value = interaction.values[0];
  if (interaction.values.length !== 1 || value === undefined) {
    throw new SettingsViewError("stale", "settings navigation is malformed");
  }
  return value;
}

function routeRequest(route: SettingsRoute): SettingsViewRequest {
  return {
    categoryId: route.categoryId,
    subcategoryId: route.subcategoryId,
    page: route.page,
  };
}

function draftKey(userId: string, route: SettingsRoute): string {
  return [
    userId,
    route.categoryId,
    route.subcategoryId,
    route.fieldId ?? "-",
  ].join(":");
}

function rememberDraft(
  drafts: Map<string, Readonly<Record<string, string>>>,
  key: string,
  values: Readonly<Record<string, string>>,
): void {
  drafts.delete(key);
  drafts.set(key, values);
  if (drafts.size > 1_000) {
    const oldest = drafts.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      drafts.delete(oldest);
    }
  }
}

function formatIssues(issues: readonly SettingsValidationIssue[]): string {
  if (issues.length === 0) {
    return "The setting could not be validated. Review it and try again.";
  }
  return issues
    .slice(0, 8)
    .map((issue) =>
      issue.inputId === undefined
        ? issue.message
        : `**${issue.inputId}:** ${issue.message}`,
    )
    .join("\n");
}

function replyView(
  components: readonly APIMessageTopLevelComponent[],
): InteractionReplyOptions {
  return {
    components,
    flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
    allowedMentions: NO_MENTIONS,
  };
}

function updateViewPayload(
  components: readonly APIMessageTopLevelComponent[],
): InteractionUpdateOptions {
  return { components, allowedMentions: NO_MENTIONS };
}

async function staleInteraction(
  interaction: SettingsComponentInteraction,
): Promise<SettingsDispatchResult> {
  await respondEphemeral(interaction, staleMessage());
  return { matched: true, status: "stale" };
}

async function respondEphemeral(
  interaction: RepliableInteraction,
  content: string,
): Promise<void> {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
    } else {
      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
    }
  } catch {
    // The interaction may already have been acknowledged by a failed transport.
  }
}

async function reportError<Context>(
  onError: SettingsRuntimeOptions<Context>["onError"],
  error: unknown,
  interaction: RepliableInteraction,
  context: Context,
): Promise<void> {
  try {
    await onError?.(error, interaction, context);
  } catch {
    // Error reporting must never replace the safe user-facing response.
  }
}

function staleMessage(): string {
  return "This settings control is outdated. Reopen settings and try again.";
}

function failureMessage(): string {
  return "Settings could not be updated right now. Try again shortly.";
}
