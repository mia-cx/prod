import { describe, expect, it, vi } from "vitest";

import type { Action, TextCommandMessage } from "../src/index.js";
import {
  createTextCommandProvider,
  createActionRegistry,
  dispatchTextCommand,
  textCommandTrigger,
} from "../src/index.js";

type TestContext = { events: string[] };
type TestCheck = { permission: string };

const message = (
  content: string,
  overrides: Partial<TextCommandMessage> = {},
): TextCommandMessage => ({
  content,
  author: {
    id: "user-1",
    username: "reporter",
    globalName: "Reporter",
    bot: false,
  },
  webhookId: null,
  channelId: "channel-1",
  guildId: "guild-1",
  ...overrides,
});

const action = (): Action<string, string, TestContext, TestCheck> => ({
  name: "fixture",
  description: "A consumer-defined fixture",
  input: {
    parse(input) {
      if (typeof input !== "string")
        throw new TypeError("expected text arguments");
      return input;
    },
    jsonSchema: { type: "string" },
  },
  triggers: [
    textCommandTrigger({
      name: "Report",
      description: "Create a report",
      usage: "report [summary]",
    }),
  ],
  availability: (_input, context) => {
    context.events.push("availability");
    return { available: true };
  },
  authorization: (_invocation, context) => {
    context.events.push("authorization");
    return { permission: "fixture.run" };
  },
  execute: async (invocation, context) => {
    context.events.push(`execute:${invocation.input}`);
    return invocation.input;
  },
});

describe("text command provider", () => {
  it("uses the default prefix, normalizes names, and preserves the argument tail", async () => {
    const context: TestContext = { events: [] };
    const present = vi.fn(
      (_trigger, _message, outcome, target: TestContext) => {
        target.events.push(`present:${outcome.status}`);
      },
    );
    const provider = createTextCommandProvider<TestContext>({ present });
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider],
    });
    registry.registerAction(action());
    const authorize = vi.fn((check: TestCheck) => {
      context.events.push(`authorize:${check.permission}`);
      return { authorized: true as const };
    });
    const event = message("!REPORT  keep\tthis tail  ");

    const result = await dispatchTextCommand({
      registry,
      provider,
      message: event,
      context,
      authorize,
    });

    expect(result).toMatchObject({
      consumed: true,
      result: {
        actionName: "fixture",
        triggerName: "Report",
        outcome: { status: "executed", output: "  keep\tthis tail  " },
      },
    });
    expect(context.events).toEqual([
      "availability",
      "authorization",
      "authorize:fixture.run",
      "execute:  keep\tthis tail  ",
      "present:executed",
    ]);
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Report" }),
      event,
      { status: "executed", output: "  keep\tthis tail  " },
      context,
    );
  });

  it("lets each text trigger parse the untouched tail into shared action input", async () => {
    const provider = createTextCommandProvider<TestContext>();
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider],
    });
    const fixture = action();
    registry.registerAction({
      ...fixture,
      triggers: [
        textCommandTrigger<string>({
          name: "report",
          description: "Create a report",
          parse: (tail, event) => `${event.author.id}:${tail}`,
        }),
      ],
    });

    const result = await dispatchTextCommand({
      registry,
      provider,
      message: message("!report  preserve me "),
      context: { events: [] },
      authorize: () => ({ authorized: true }),
    });

    expect(result).toMatchObject({
      consumed: true,
      result: {
        outcome: { status: "executed", output: "user-1:  preserve me " },
      },
    });
  });

  it("honors a configured Unicode prefix of at most eight code points", async () => {
    const provider = createTextCommandProvider<TestContext>({
      prefix: "🚀🚀🚀🚀🚀🚀🚀🚀",
    });
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider],
    });
    registry.registerAction(action());

    const result = await dispatchTextCommand({
      registry,
      provider,
      message: message("🚀🚀🚀🚀🚀🚀🚀🚀report summary"),
      context: { events: [] },
      authorize: () => ({ authorized: true }),
    });

    expect(result.consumed).toBe(true);
    expect(() => createTextCommandProvider({ prefix: "123456789" })).toThrow(
      /1-8 Unicode code points/,
    );
  });

  it.each(["", "report now", "report\tnow"])(
    "rejects unreachable command names (%j)",
    (name) => {
      expect(() =>
        textCommandTrigger({ name, description: "Invalid command" }),
      ).toThrow(/one non-whitespace token/);
    },
  );

  it.each(["", " \t\n "])(
    "disables registration and dispatch for an empty prefix (%j)",
    async (prefix) => {
      const provider = createTextCommandProvider<TestContext>({ prefix });
      const registry = createActionRegistry<TestContext, TestCheck>({
        providers: [provider],
      });
      registry.registerAction(action());

      expect(provider.prefix).toBeUndefined();
      expect(registry.getTriggers(provider.id)).toEqual([]);
      await expect(
        dispatchTextCommand({
          registry,
          provider,
          message: message("!report ignored"),
          context: { events: [] },
          authorize: () => ({ authorized: true }),
        }),
      ).resolves.toEqual({ consumed: false });
    },
  );

  it.each([
    ["bot", { author: { id: "bot-1", username: "bot", bot: true } }],
    ["webhook", { webhookId: "webhook-1" }],
  ])("ignores %s-authored messages", async (_name, overrides) => {
    const provider = createTextCommandProvider<TestContext>();
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider],
    });
    registry.registerAction(action());
    const context: TestContext = { events: [] };

    const result = await dispatchTextCommand({
      registry,
      provider,
      message: message("!report ignored", overrides),
      context,
      authorize: () => ({ authorized: true }),
    });

    expect(result).toEqual({ consumed: false });
    expect(context.events).toEqual([]);
  });

  it.each(["ordinary message", "!unknown args", "!"])(
    "does not consume an unmatched message: %s",
    async (content) => {
      const provider = createTextCommandProvider<TestContext>();
      const registry = createActionRegistry<TestContext, TestCheck>({
        providers: [provider],
      });
      registry.registerAction(action());

      await expect(
        dispatchTextCommand({
          registry,
          provider,
          message: message(content),
          context: { events: [] },
          authorize: () => ({ authorized: true }),
        }),
      ).resolves.toEqual({ consumed: false });
    },
  );

  it("selects the first whitespace-delimited token after the prefix", async () => {
    const provider = createTextCommandProvider<TestContext>();
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider],
    });
    registry.registerAction(action());

    const result = await dispatchTextCommand({
      registry,
      provider,
      message: message("! \t report\nremaining"),
      context: { events: [] },
      authorize: () => ({ authorized: true }),
    });

    expect(result).toMatchObject({
      consumed: true,
      result: { outcome: { status: "executed", output: "\nremaining" } },
    });
  });

  it("consumes matched commands even when the lifecycle does not execute", async () => {
    const provider = createTextCommandProvider<TestContext>();
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [provider],
    });
    registry.registerAction(action());

    const result = await dispatchTextCommand({
      registry,
      provider,
      message: message("!report denied"),
      context: { events: [] },
      authorize: () => ({ authorized: false, reason: "nope" }),
    });

    expect(result).toMatchObject({
      consumed: true,
      result: { outcome: { status: "unauthorized", reason: "nope" } },
    });
  });

  it("rejects a dispatcher configured differently from the registered provider", async () => {
    const registered = createTextCommandProvider<TestContext>({ prefix: "!" });
    const mismatched = createTextCommandProvider<TestContext>({ prefix: "?" });
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: [registered],
    });
    registry.registerAction(action());

    await expect(
      dispatchTextCommand({
        registry,
        provider: mismatched,
        message: message("?report should not dispatch"),
        context: { events: [] },
        authorize: () => ({ authorized: true }),
      }),
    ).rejects.toThrow(/not registered with this registry/);
  });
});
