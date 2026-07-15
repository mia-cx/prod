import type {
  Action,
  ActionInvocation,
  Authorize,
  DispatchOutcome,
  DispatchRequest,
  DispatchResult,
  RegisteredTrigger,
  TriggerDefinition,
  TriggerProvider,
} from "./contracts.js";

type AnyAction<Context, AuthorizationCheck> = Action<
  unknown,
  unknown,
  Context,
  AuthorizationCheck
>;

type AnyProvider<Context> = TriggerProvider<Context>;

type ResolvedTrigger<Context, AuthorizationCheck> = Readonly<{
  action: AnyAction<Context, AuthorizationCheck>;
  trigger: TriggerDefinition<unknown, Context, AuthorizationCheck>;
  provider: AnyProvider<Context>;
  key: string;
}>;

export interface ActionRegistry<Context, AuthorizationCheck = never> {
  readonly actions: readonly AnyAction<Context, AuthorizationCheck>[];
  readonly providers: readonly AnyProvider<Context>[];
  registerProvider(provider: AnyProvider<Context>): void;
  registerAction<Input, Output>(
    action: Action<Input, Output, Context, AuthorizationCheck>,
  ): void;
  getAction(name: string): AnyAction<Context, AuthorizationCheck> | undefined;
  getProvider(providerId: string): AnyProvider<Context> | undefined;
  getTrigger(
    providerId: string,
    triggerName: string,
  ): RegisteredTrigger<Context, AuthorizationCheck> | undefined;
  getTriggers(
    providerId: string,
  ): readonly RegisteredTrigger<Context, AuthorizationCheck>[];
  dispatch(
    request: DispatchRequest<Context, AuthorizationCheck>,
  ): Promise<DispatchResult>;
}

export function createActionRegistry<
  Context,
  AuthorizationCheck = never,
>(input?: {
  providers?: readonly AnyProvider<Context>[];
}): ActionRegistry<Context, AuthorizationCheck> {
  const actions = new Map<string, AnyAction<Context, AuthorizationCheck>>();
  const providers = new Map<string, AnyProvider<Context>>();
  const triggers = new Map<
    string,
    Map<string, ResolvedTrigger<Context, AuthorizationCheck>>
  >();

  const registry: ActionRegistry<Context, AuthorizationCheck> = {
    get actions() {
      return [...actions.values()];
    },
    get providers() {
      return [...providers.values()];
    },
    registerProvider(provider) {
      if (providers.has(provider.id)) {
        throw new Error(`Duplicate trigger provider: ${provider.id}`);
      }
      providers.set(provider.id, provider);
      triggers.set(provider.id, new Map());
    },
    registerAction(action) {
      if (actions.has(action.name)) {
        throw new Error(`Duplicate action name: ${action.name}`);
      }

      const pending: ResolvedTrigger<Context, AuthorizationCheck>[] = [];
      const pendingKeys = new Set<string>();
      for (const trigger of action.triggers) {
        const provider = providers.get(trigger.providerId);
        if (!provider) {
          throw new Error(
            `Unknown trigger provider ${trigger.providerId} for action ${action.name}`,
          );
        }

        const erasedTrigger: TriggerDefinition<
          unknown,
          Context,
          AuthorizationCheck
        > = trigger;
        if (!provider.isTrigger(erasedTrigger)) {
          throw new Error(
            `Trigger ${trigger.name} is invalid for provider ${provider.id}`,
          );
        }
        const key = provider.getTriggerKey(erasedTrigger);
        if (key === undefined) {
          continue;
        }
        const normalizedKey = provider.normalizeLookupKey(key);
        const scopedKey = `${provider.id}\u0000${normalizedKey}`;
        const existing = triggers.get(provider.id)?.get(normalizedKey);
        if (existing || pendingKeys.has(scopedKey)) {
          const existingAction = existing?.action.name ?? action.name;
          throw new Error(
            `Duplicate ${provider.id} trigger: ${normalizedKey} (${existingAction}, ${action.name})`,
          );
        }
        pendingKeys.add(scopedKey);
        pending.push({
          action: action as AnyAction<Context, AuthorizationCheck>,
          trigger: erasedTrigger,
          provider,
          key: normalizedKey,
        });
      }

      actions.set(
        action.name,
        action as AnyAction<Context, AuthorizationCheck>,
      );
      for (const entry of pending) {
        triggers.get(entry.provider.id)?.set(entry.key, entry);
      }
    },
    getAction(name) {
      return actions.get(name);
    },
    getProvider(providerId) {
      return providers.get(providerId);
    },
    getTrigger(providerId, triggerName) {
      const entry = resolveTrigger(
        providers,
        triggers,
        providerId,
        triggerName,
      );
      return entry && toRegisteredTrigger(entry);
    },
    getTriggers(providerId) {
      return [...(triggers.get(providerId)?.values() ?? [])].map(
        toRegisteredTrigger,
      );
    },
    async dispatch(request) {
      const entry = resolveTrigger(
        providers,
        triggers,
        request.providerId,
        request.triggerName,
      );
      if (!entry) {
        return { matched: false };
      }

      if (!entry.provider.isEvent(request.event)) {
        return {
          matched: true,
          actionName: entry.action.name,
          triggerName: entry.trigger.name,
          outcome: {
            status: "failed",
            error: new TypeError(
              `Invalid event for trigger provider ${entry.provider.id}`,
            ),
          },
        };
      }

      const outcome = await invoke(
        entry,
        request.context,
        request.event,
        request.authorize,
      );
      let presentationError: unknown;
      try {
        await entry.provider.present(
          entry.trigger,
          request.event,
          outcome,
          request.context,
        );
      } catch (error) {
        presentationError = error;
      }
      return {
        matched: true,
        actionName: entry.action.name,
        triggerName: entry.trigger.name,
        outcome,
        ...(presentationError === undefined ? {} : { presentationError }),
      };
    },
  };

  for (const provider of input?.providers ?? []) {
    registry.registerProvider(provider);
  }
  return registry;
}

function resolveTrigger<Context, AuthorizationCheck>(
  providers: ReadonlyMap<string, AnyProvider<Context>>,
  triggers: ReadonlyMap<
    string,
    ReadonlyMap<string, ResolvedTrigger<Context, AuthorizationCheck>>
  >,
  providerId: string,
  triggerName: string,
): ResolvedTrigger<Context, AuthorizationCheck> | undefined {
  const provider = providers.get(providerId);
  if (!provider) {
    return undefined;
  }
  return triggers
    .get(providerId)
    ?.get(provider.normalizeLookupKey(triggerName));
}

function toRegisteredTrigger<Context, AuthorizationCheck>(
  entry: ResolvedTrigger<Context, AuthorizationCheck>,
): RegisteredTrigger<Context, AuthorizationCheck> {
  return {
    actionName: entry.action.name,
    providerId: entry.provider.id,
    triggerName: entry.trigger.name,
    trigger: entry.trigger,
  };
}

async function invoke<Context, AuthorizationCheck>(
  entry: ResolvedTrigger<Context, AuthorizationCheck>,
  context: Context,
  event: unknown,
  authorize: Authorize<Context, AuthorizationCheck> | undefined,
): Promise<DispatchOutcome> {
  try {
    const parsed = entry.provider.parse(entry.trigger, event);
    const input = entry.action.input.parse(parsed);
    const invocation: ActionInvocation<unknown> = {
      ...entry.provider.getInvocationDetails(entry.trigger, event),
      triggerName: entry.trigger.name,
      input,
      rawEvent: event,
    };
    const availability = await entry.action.availability(context);
    if (!availability.available) {
      return { status: "unavailable", reason: availability.reason };
    }

    const check = await entry.action.authorization(invocation, context);
    if (check !== undefined) {
      if (!authorize) {
        throw new Error(
          `Action ${entry.action.name} requires authorization but no authorizer was provided`,
        );
      }
      const decision = await authorize(check, invocation, context);
      if (!decision.authorized) {
        return { status: "unauthorized", reason: decision.reason };
      }
    }

    const readiness = await entry.action.readiness?.({ invocation }, context);
    if (readiness && !readiness.available) {
      return { status: "unavailable", reason: readiness.reason };
    }

    return {
      status: "executed",
      output: await entry.action.execute(invocation, context),
    };
  } catch (error) {
    return { status: "failed", error };
  }
}
