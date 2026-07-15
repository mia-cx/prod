import { describe, expect, it, vi } from "vitest";

import type {
  Action,
  DispatchOutcome,
  TriggerDefinition,
  TriggerProvider,
} from "../src/index.js";
import { createActionRegistry } from "../src/index.js";

type FutureContext = {
  trace: string[];
  presentations: DispatchOutcome[];
};

type FutureAuthorizationCheck = Readonly<{ capability: string }>;

type FutureTrigger = TriggerDefinition<string> &
  Readonly<{
    providerId: "future-events";
    topic: string;
  }>;

type FutureEvent = Readonly<{
  topic: string;
  payload: unknown;
  actor: Readonly<{ id: string; name: string }>;
}>;

const futureTrigger = (name: string, topic: string): FutureTrigger => ({
  providerId: "future-events",
  name,
  topic,
  description: `Run ${name} from a future event`,
  usage: topic,
});

const futureProvider = (
  trace: string[],
): TriggerProvider<FutureContext, FutureTrigger, FutureEvent> => ({
  id: "future-events",
  isTrigger: (trigger): trigger is FutureTrigger =>
    trigger.providerId === "future-events" && "topic" in trigger,
  isEvent: (event): event is FutureEvent =>
    event !== null &&
    typeof event === "object" &&
    "topic" in event &&
    "payload" in event &&
    "actor" in event,
  getTriggerKey: (trigger) => trigger.topic,
  normalizeLookupKey: (key) => key.trim().toLocaleLowerCase(),
  parse: (_trigger, event) => {
    trace.push("provider:parse");
    return event.payload;
  },
  getInvocationDetails: (_trigger, event) => {
    trace.push("provider:invocation-details");
    return {
      source: "future-event-bus",
      requester: event.actor,
    };
  },
  present: (_trigger, _event, outcome, context) => {
    context.trace.push(`provider:present:${outcome.status}`);
    context.presentations.push(outcome);
  },
});

const fixtureAction = (
  trace: string[],
): Action<string, string, FutureContext, FutureAuthorizationCheck> => ({
  name: "consumer-fixture",
  description: "A fixture owned entirely by the package consumer",
  input: {
    parse: (input) => {
      trace.push("input:parse");
      if (typeof input !== "string")
        throw new TypeError("expected string payload");
      return input;
    },
    jsonSchema: { type: "string" },
  },
  triggers: [futureTrigger("on-ready", "Deployments/Ready")],
  availability: ({ invocation }, context) => {
    context.trace.push(`availability:${invocation.source}`);
    return { available: true };
  },
  authorization: (invocation, context) => {
    context.trace.push(`authorization:${invocation.requester?.id}`);
    return { capability: "deployments.read" };
  },
  execute: async (invocation, context) => {
    context.trace.push(`execute:${invocation.input}`);
    return invocation.input.toUpperCase();
  },
});

describe("external trigger-provider extensibility", () => {
  it("dispatches a consumer-defined provider through the canonical lifecycle", async () => {
    const trace: string[] = [];
    const context: FutureContext = { trace, presentations: [] };
    const registry = createActionRegistry<
      FutureContext,
      FutureAuthorizationCheck
    >();
    registry.registerProvider(futureProvider(trace));
    registry.registerAction(fixtureAction(trace));
    const authorize = vi.fn((check: FutureAuthorizationCheck) => {
      trace.push(`authorizer:${check.capability}`);
      return { authorized: true as const };
    });

    const result = await registry.dispatch({
      providerId: "future-events",
      triggerName: "  deployments/READY ",
      event: {
        topic: "Deployments/Ready",
        payload: "ship it",
        actor: { id: "consumer-42", name: "Consumer" },
      } satisfies FutureEvent,
      context,
      authorize,
    });

    expect(result).toEqual({
      matched: true,
      actionName: "consumer-fixture",
      triggerName: "on-ready",
      outcome: { status: "executed", output: "SHIP IT" },
    });
    expect(trace).toEqual([
      "provider:parse",
      "input:parse",
      "provider:invocation-details",
      "availability:future-event-bus",
      "authorization:consumer-42",
      "authorizer:deployments.read",
      "execute:ship it",
      "provider:present:executed",
    ]);
    expect(authorize).toHaveBeenCalledWith(
      { capability: "deployments.read" },
      expect.objectContaining({
        source: "future-event-bus",
        triggerName: "on-ready",
        input: "ship it",
        requester: { id: "consumer-42", name: "Consumer" },
      }),
      context,
    );
    expect(context.presentations).toEqual([
      { status: "executed", output: "SHIP IT" },
    ]);
  });

  it("returns and presents a failed outcome when the consumer omits an authorizer", async () => {
    const trace: string[] = [];
    const context: FutureContext = { trace, presentations: [] };
    const registry = createActionRegistry<
      FutureContext,
      FutureAuthorizationCheck
    >({
      providers: [futureProvider(trace)],
    });
    registry.registerAction(fixtureAction(trace));

    const result = await registry.dispatch({
      providerId: "future-events",
      triggerName: "deployments/ready",
      event: {
        topic: "Deployments/Ready",
        payload: "ship it",
        actor: { id: "consumer-42", name: "Consumer" },
      } satisfies FutureEvent,
      context,
    });

    expect(result.matched && result.outcome).toEqual({
      status: "failed",
      error: expect.objectContaining({
        message:
          "Action consumer-fixture requires authorization but no authorizer was provided",
      }),
    });
    expect(trace).toEqual([
      "provider:parse",
      "input:parse",
      "provider:invocation-details",
      "availability:future-event-bus",
      "authorization:consumer-42",
      "provider:present:failed",
    ]);
    expect(context.presentations).toEqual([
      { status: "failed", error: expect.any(Error) },
    ]);
  });
});
