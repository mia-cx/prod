import { describe, expect, it, vi } from "vitest";

import type {
  Action,
  TriggerDefinition,
  TriggerProvider,
} from "../src/index.js";
import { createActionRegistry, protocordBoundary } from "../src/index.js";

type TestContext = { events: string[] };
type TestCheck = { permission: string };

const provider = (): TriggerProvider<TestContext> => ({
  id: "test",
  isTrigger: (value): value is TriggerDefinition<unknown> =>
    value.providerId === "test",
  isEvent: (event): event is unknown => event !== Symbol.for("invalid-event"),
  getTriggerKey: (trigger) => trigger.name,
  normalizeLookupKey: (key) => key.toLowerCase(),
  parse: (_trigger, event) => event,
  getInvocationDetails: () => ({ source: "test" }),
  present: (_trigger, _event, outcome, context) => {
    context.events.push(`present:${outcome.status}`);
  },
});

const trigger = (name: string): TriggerDefinition<string> => ({
  providerId: "test",
  name,
  description: `Run ${name}`,
  usage: name,
});

const action = (
  overrides: Partial<Action<string, string, TestContext, TestCheck>> = {},
): Action<string, string, TestContext, TestCheck> => ({
  name: "fixture",
  description: "A consumer-owned fixture action",
  input: {
    parse: (input) => {
      if (typeof input !== "string") throw new TypeError("expected string");
      return input;
    },
    jsonSchema: { type: "string" },
  },
  triggers: [trigger("fixture")],
  availability: (_input, context) => {
    context.events.push("availability");
    return { available: true };
  },
  authorization: (_invocation, context) => {
    context.events.push("authorization");
    return { permission: "fixture.run" };
  },
  execute: async (invocation, context) => {
    context.events.push("execute");
    return invocation.input.toUpperCase();
  },
  ...overrides,
});

describe("action registry", () => {
  it("runs every provider through the canonical lifecycle and presentation", async () => {
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider()],
    });
    registry.registerAction(action());
    const context: TestContext = { events: [] };
    const authorize = vi.fn((check: TestCheck) => {
      context.events.push(`authorize:${check.permission}`);
      return { authorized: true as const };
    });

    const result = await registry.dispatch({
      providerId: "test",
      triggerName: "FIXTURE",
      event: "hello",
      context,
      authorize,
    });

    expect(result).toEqual({
      matched: true,
      actionName: "fixture",
      triggerName: "fixture",
      outcome: { status: "executed", output: "HELLO" },
    });
    expect(context.events).toEqual([
      "availability",
      "authorization",
      "authorize:fixture.run",
      "execute",
      "present:executed",
    ]);
  });

  it.each([
    [
      "unavailable",
      action({ availability: () => ({ available: false, reason: "not now" }) }),
      { status: "unavailable", reason: "not now" },
    ],
    [
      "failed parsing",
      action(),
      { status: "failed", error: expect.any(TypeError) },
    ],
  ])(
    "presents %s outcomes without executing",
    async (_name, fixture, expected) => {
      const registry = createActionRegistry<TestContext, TestCheck>({
        providers: [provider()],
      });
      registry.registerAction(fixture);
      const context: TestContext = { events: [] };
      const event = _name === "failed parsing" ? 42 : "hello";

      const result = await registry.dispatch({
        providerId: "test",
        triggerName: "fixture",
        event,
        context,
        authorize: () => ({ authorized: true }),
      });

      expect(result.matched && result.outcome).toEqual(expected);
      expect(context.events).not.toContain("execute");
      expect(context.events.at(-1)).toMatch(/^present:/);
    },
  );

  it("presents authorization denials without executing", async () => {
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider()],
    });
    registry.registerAction(action());
    const context: TestContext = { events: [] };

    const result = await registry.dispatch({
      providerId: "test",
      triggerName: "fixture",
      event: "hello",
      context,
      authorize: () => ({ authorized: false, reason: "nope" }),
    });

    expect(result.matched && result.outcome).toEqual({
      status: "unauthorized",
      reason: "nope",
    });
    expect(context.events).not.toContain("execute");
  });

  it("rejects conflicts atomically within a provider", () => {
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider()],
    });
    registry.registerAction(action({ name: "first" }));

    expect(() =>
      registry.registerAction(
        action({
          name: "second",
          triggers: [trigger("unique"), trigger("FIXTURE")],
        }),
      ),
    ).toThrow(/Duplicate test trigger/);
    expect(registry.getAction("second")).toBeUndefined();
    expect(registry.getTrigger("test", "unique")).toBeUndefined();
    expect(registry.actions.map(({ name }) => name)).toEqual(["first"]);
  });

  it("rejects duplicate action names before indexing their triggers", () => {
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider()],
    });
    registry.registerAction(action());

    expect(() =>
      registry.registerAction(
        action({ triggers: [trigger("otherwise-unique")] }),
      ),
    ).toThrow(/Duplicate action name/);
    expect(registry.getTrigger("test", "otherwise-unique")).toBeUndefined();
  });

  it("allows the same trigger name in different providers", () => {
    const secondProvider: TriggerProvider<TestContext> = {
      ...provider(),
      id: "second",
      isTrigger: (value): value is TriggerDefinition<unknown> =>
        value.providerId === "second",
    };
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider(), secondProvider],
    });
    registry.registerAction(action({ name: "first" }));
    registry.registerAction(
      action({
        name: "second",
        triggers: [{ ...trigger("fixture"), providerId: "second" }],
      }),
    );

    expect(registry.getTrigger("test", "fixture")?.actionName).toBe("first");
    expect(registry.getTrigger("second", "fixture")?.actionName).toBe("second");
  });

  it("lets disabled providers omit triggers from registration", () => {
    const disabled: TriggerProvider<TestContext> = {
      ...provider(),
      getTriggerKey: () => undefined,
    };
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [disabled],
    });
    registry.registerAction(action());

    expect(registry.actions).toHaveLength(1);
    expect(registry.getTriggers("test")).toEqual([]);
  });

  it("rejects unknown and duplicate providers without mutating actions", () => {
    const registry = createActionRegistry<TestContext, TestCheck>();
    expect(() => registry.registerAction(action())).toThrow(
      /Unknown trigger provider/,
    );
    expect(registry.actions).toEqual([]);

    registry.registerProvider(provider());
    expect(() => registry.registerProvider(provider())).toThrow(
      /Duplicate trigger provider/,
    );
  });

  it("ignores unknown trigger lookups without presenting anything", async () => {
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider()],
    });
    registry.registerAction(action());
    const context: TestContext = { events: [] };

    await expect(
      registry.dispatch({
        providerId: "test",
        triggerName: "missing",
        event: "hello",
        context,
      }),
    ).resolves.toEqual({ matched: false });
    expect(context.events).toEqual([]);
  });

  it("preserves an executed result when presentation fails", async () => {
    const brokenPresenter: TriggerProvider<TestContext> = {
      ...provider(),
      present: () => {
        throw new Error("Discord is unavailable");
      },
    };
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [brokenPresenter],
    });
    registry.registerAction(action());

    const result = await registry.dispatch({
      providerId: "test",
      triggerName: "fixture",
      event: "hello",
      context: { events: [] },
      authorize: () => ({ authorized: true }),
    });

    expect(result).toEqual({
      matched: true,
      actionName: "fixture",
      triggerName: "fixture",
      outcome: { status: "executed", output: "HELLO" },
      presentationError: expect.objectContaining({
        message: "Discord is unavailable",
      }),
    });
  });

  it("rejects invalid provider events before parsing or execution", async () => {
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider()],
    });
    registry.registerAction(action());
    const context: TestContext = { events: [] };

    const result = await registry.dispatch({
      providerId: "test",
      triggerName: "fixture",
      event: Symbol.for("invalid-event"),
      context,
    });

    expect(result.matched && result.outcome).toEqual({
      status: "failed",
      error: expect.any(TypeError),
    });
    expect(context.events).toEqual([]);
  });
});

describe("protocord package boundary", () => {
  it("does not ship a default action catalog", () => {
    expect(protocordBoundary).toEqual({
      name: "protocord",
      concreteActionCount: 0,
    });
  });
});
