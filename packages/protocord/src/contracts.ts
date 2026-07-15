export type Awaitable<Value> = Value | Promise<Value>;

export type JsonSchema = Readonly<Record<string, unknown>>;

export type ActionInput<Input> = Readonly<{
  parse(input: unknown): Input;
  jsonSchema: JsonSchema;
}>;

export type ActionAvailability =
  | Readonly<{ available: true; reason?: string }>
  | Readonly<{ available: false; reason: string }>;

export type ActionRequester = Readonly<{
  id: string;
  name: string;
}>;

export type ActionInvocation<Input> = Readonly<{
  source: string;
  triggerName: string;
  input: Input;
  rawEvent: unknown;
  channelId?: string;
  guildId?: string;
  requester?: ActionRequester;
}>;

export type ActionReadinessInput<Input> = Readonly<{
  invocation: ActionInvocation<Input>;
}>;

export type TriggerDefinition<Input> = Readonly<{
  providerId: string;
  name: string;
  description: string;
  usage: string;
  readonly __input?: Input;
}>;

export type Action<
  Input,
  Output,
  Context,
  AuthorizationCheck = never,
> = Readonly<{
  name: string;
  description: string;
  input: ActionInput<Input>;
  triggers: readonly TriggerDefinition<Input>[];
  /** Public, invocation-independent availability checked before authorization. */
  availability(context: Context): Awaitable<ActionAvailability>;
  authorization(
    invocation: ActionInvocation<Input>,
    context: Context,
  ): Awaitable<AuthorizationCheck | undefined>;
  /** Invocation-sensitive readiness checked only after authorization succeeds. */
  readiness?(
    input: ActionReadinessInput<Input>,
    context: Context,
  ): Awaitable<ActionAvailability>;
  execute(
    invocation: ActionInvocation<Input>,
    context: Context,
  ): Promise<Output>;
}>;

export type AuthorizationDecision =
  | Readonly<{ authorized: true }>
  | Readonly<{ authorized: false; reason: string }>;

export type DispatchOutcome<Output = unknown> =
  | Readonly<{ status: "executed"; output: Output }>
  | Readonly<{ status: "unavailable"; reason: string }>
  | Readonly<{ status: "unauthorized"; reason: string }>
  | Readonly<{ status: "failed"; error: unknown }>;

export type InvocationDetails = Readonly<{
  source: string;
  channelId?: string;
  guildId?: string;
  requester?: ActionRequester;
}>;

export type TriggerProvider<
  Context,
  Trigger extends TriggerDefinition<unknown> = TriggerDefinition<unknown>,
  Event = unknown,
> = Readonly<{
  id: string;
  isTrigger(trigger: TriggerDefinition<unknown>): trigger is Trigger;
  isEvent(event: unknown): event is Event;
  getTriggerKey(trigger: Trigger): string | undefined;
  normalizeLookupKey(key: string): string;
  parse(trigger: Trigger, event: Event): unknown;
  getInvocationDetails(trigger: Trigger, event: Event): InvocationDetails;
  present(
    trigger: Trigger,
    event: Event,
    outcome: DispatchOutcome,
    context: Context,
  ): Awaitable<void>;
}>;

export type Authorize<Context, AuthorizationCheck> = (
  check: AuthorizationCheck,
  invocation: ActionInvocation<unknown>,
  context: Context,
) => Awaitable<AuthorizationDecision>;

export type DispatchRequest<Context, AuthorizationCheck> = Readonly<{
  providerId: string;
  triggerName: string;
  event: unknown;
  context: Context;
  authorize?: Authorize<Context, AuthorizationCheck>;
}>;

export type DispatchResult =
  | Readonly<{ matched: false }>
  | Readonly<{
      matched: true;
      actionName: string;
      triggerName: string;
      outcome: DispatchOutcome;
      presentationError?: unknown;
    }>;

export type RegisteredTrigger = Readonly<{
  actionName: string;
  providerId: string;
  triggerName: string;
  trigger: TriggerDefinition<unknown>;
}>;
