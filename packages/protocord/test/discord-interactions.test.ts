import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type {
  Action,
  ActionInvocation,
  TriggerDefinition,
} from "../src/index.js";
import {
  createActionRegistry,
  createDiscordInteractionProviders,
  dispatchDiscordAutocomplete,
  dispatchDiscordInteraction,
  getDiscordCommandRegistration,
  handleDiscordInteraction,
  messageContextMenu,
  registerDiscordCommands,
  slashCommand,
  userContextMenu,
} from "../src/index.js";

type TestContext = {
  events: string[];
  invocations: ActionInvocation<string>[];
};
type TestCheck = { permission: string };

function context(): TestContext {
  return { events: [], invocations: [] };
}

function action(
  triggers: readonly TriggerDefinition<string>[],
  overrides: Partial<Action<string, string, TestContext>> = {},
): Action<string, string, TestContext> {
  return {
    name: "fixture",
    description: "A consumer-owned action",
    input: {
      parse: (input) => {
        if (typeof input !== "string") throw new TypeError("expected string");
        return input;
      },
      jsonSchema: { type: "string" },
    },
    triggers,
    availability: (_input, testContext) => {
      testContext.events.push("availability");
      return { available: true };
    },
    authorization: (_invocation, testContext) => {
      testContext.events.push("authorization");
      return undefined;
    },
    execute: async (invocation, testContext) => {
      testContext.events.push("execute");
      testContext.invocations.push(invocation);
      return invocation.input.toUpperCase();
    },
    ...overrides,
  };
}

type InteractionKind =
  "autocomplete" | "message" | "slash" | "unsupported" | "user";

function interaction(
  kind: InteractionKind,
  commandName: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Interaction {
  const result: Record<string, unknown> = {
    commandName,
    channelId: "channel-1",
    guildId: "guild-1",
    user: {
      id: "user-1",
      username: "fixture-user",
      globalName: "Fixture User",
    },
    replied: false,
    deferred: false,
    isAutocomplete: () => kind === "autocomplete",
    isChatInputCommand: () => kind === "slash",
    isMessageContextMenuCommand: () => kind === "message",
    isUserContextMenuCommand: () => kind === "user",
    deferReply: vi.fn().mockImplementation(async () => {
      result.deferred = true;
    }),
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return result as unknown as Interaction;
}

describe("built-in Discord interaction providers", () => {
  it.each([
    [
      "slash",
      slashCommand<string, TestContext>({
        name: "inspect",
        description: "Inspect something",
        parse: () => "slash input",
        present: (outcome, _interaction, testContext) => {
          testContext.events.push(`slash-present:${outcome.status}`);
        },
      }),
      {},
      "discord:slash-command",
      "slash-present:executed",
    ],
    [
      "message",
      messageContextMenu<string, TestContext>({
        name: "Inspect message",
        parse: (event) => `message ${event.targetMessage.id}`,
        present: (outcome, _interaction, testContext) => {
          testContext.events.push(`message-present:${outcome.status}`);
        },
      }),
      { targetMessage: { id: "message-1" } },
      "discord:message-context",
      "message-present:executed",
    ],
    [
      "user",
      userContextMenu<string, TestContext>({
        name: "Inspect user",
        parse: (event) => `user ${event.targetUser.id}`,
        present: (outcome, _interaction, testContext) => {
          testContext.events.push(`user-present:${outcome.status}`);
        },
      }),
      { targetUser: { id: "target-1" } },
      "discord:user-context",
      "user-present:executed",
    ],
  ] as const)(
    "dispatches a %s command through the canonical lifecycle",
    async (kind, trigger, eventData, source, presentation) => {
      const registry = createActionRegistry<TestContext>({
        providers: createDiscordInteractionProviders<TestContext>(),
      });
      registry.registerAction(action([trigger]));
      const testContext = context();

      const result = await dispatchDiscordInteraction(
        registry,
        interaction(kind, trigger.name, eventData),
        testContext,
      );

      expect(result).toEqual({
        matched: true,
        actionName: "fixture",
        triggerName: trigger.name,
        outcome: { status: "executed", output: expect.any(String) },
      });
      expect(testContext.events).toEqual([
        "availability",
        "authorization",
        "execute",
        presentation,
      ]);
      expect(testContext.invocations[0]).toMatchObject({
        source,
        channelId: "channel-1",
        guildId: "guild-1",
        requester: { id: "user-1", name: "Fixture User" },
        triggerName: trigger.name,
      });
    },
  );

  it("supports slash aliases as independently registered definitions", async () => {
    const registry = createActionRegistry<TestContext>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    registry.registerAction(
      action([
        slashCommand({
          name: "inspect",
          description: "Inspect",
          parse: () => "primary",
        }),
        slashCommand({
          name: "i",
          description: "Inspect",
          parse: () => "alias",
        }),
      ]),
    );
    const testContext = context();

    const result = await dispatchDiscordInteraction(
      registry,
      interaction("slash", "I"),
      testContext,
    );

    expect(result.matched && result.triggerName).toBe("i");
    expect(testContext.invocations[0]?.input).toBe("alias");
  });

  it("routes autocomplete through its slash trigger without running the action", async () => {
    const autocomplete = vi.fn(() => [{ name: "Ticket 42", value: "42" }]);
    const present = vi.fn();
    const registry = createActionRegistry<TestContext>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    registry.registerAction(
      action([
        slashCommand<string, TestContext>({
          name: "ticket",
          description: "Find a ticket",
          parse: () => "unused",
          autocomplete: {
            availability: () => ({ available: true }),
            authorization: () => undefined,
            complete: autocomplete,
          },
          present,
        }),
      ]),
    );
    const respond = vi.fn().mockResolvedValue(undefined);
    const event = interaction("autocomplete", "TICKET", { respond });
    const testContext = context();

    await expect(
      dispatchDiscordAutocomplete(registry, event, testContext),
    ).resolves.toBe(true);

    expect(autocomplete).toHaveBeenCalledWith(event, testContext);
    expect(respond).toHaveBeenCalledWith([{ name: "Ticket 42", value: "42" }]);
    expect(testContext.events).toEqual([]);
    expect(present).not.toHaveBeenCalled();
  });

  it("does not expose autocomplete choices when authorization fails", async () => {
    const complete = vi.fn(() => [{ name: "Private ticket", value: "secret" }]);
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    registry.registerAction(
      action([
        slashCommand<string, TestContext, TestCheck>({
          name: "ticket",
          description: "Find a ticket",
          parse: () => "unused",
          autocomplete: {
            availability: () => ({ available: true }),
            authorization: () => ({ permission: "tickets.view" }),
            complete,
          },
        }),
      ]),
    );
    const respond = vi.fn().mockResolvedValue(undefined);
    const event = interaction("autocomplete", "ticket", { respond });

    await expect(
      dispatchDiscordAutocomplete(registry, event, context(), () => ({
        authorized: false,
        reason: "private",
      })),
    ).resolves.toBe(true);

    expect(respond).toHaveBeenCalledWith([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("leaves unsupported and unknown interactions unmatched without presentation", async () => {
    const present = vi.fn();
    const registry = createActionRegistry<TestContext>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    registry.registerAction(
      action([
        slashCommand({
          name: "known",
          description: "Known command",
          parse: () => "known",
          present,
        }),
      ]),
    );
    const testContext = context();

    await expect(
      handleDiscordInteraction(
        registry,
        interaction("unsupported", "known"),
        testContext,
      ),
    ).resolves.toEqual({ handled: false });
    await expect(
      handleDiscordInteraction(
        registry,
        interaction("slash", "unknown"),
        testContext,
      ),
    ).resolves.toEqual({ handled: false });

    expect(testContext.events).toEqual([]);
    expect(present).not.toHaveBeenCalled();
  });

  it("uses an ephemeral default presentation unless the trigger opts out", async () => {
    const registry = createActionRegistry<TestContext>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    registry.registerAction(
      action([
        slashCommand({
          name: "safe-default",
          description: "Keep output private",
          parse: () => "private result",
        }),
      ]),
    );
    const event = interaction("slash", "safe-default");
    const command = event as ChatInputCommandInteraction;

    await dispatchDiscordInteraction(registry, event, context());

    expect(command.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(command.editReply).toHaveBeenCalledWith({
      content: "PRIVATE RESULT",
    });
  });

  it("defers new interactions ephemerally before running the action", async () => {
    const registry = createActionRegistry<TestContext>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    registry.registerAction(
      action([
        slashCommand({
          name: "slow",
          description: "Run a slow action",
          parse: () => "slow",
          present: () => undefined,
        }),
      ]),
    );
    const event = interaction("slash", "slow");
    const command = event as ChatInputCommandInteraction;

    await dispatchDiscordInteraction(registry, event, context());

    expect(command.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
  });
});

describe("Discord application command registration", () => {
  function registryWithCommands() {
    const registry = createActionRegistry<TestContext>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    registry.registerAction(
      action([
        slashCommand({
          name: "ticket",
          description: "Find a ticket",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "query",
              description: "Ticket query",
              autocomplete: true,
            },
          ],
          registration: { dmPermission: false },
          parse: () => "ticket",
        }),
        messageContextMenu({ name: "Open ticket", parse: () => "message" }),
        userContextMenu({ name: "User tickets", parse: () => "user" }),
      ]),
    );
    return registry;
  }

  it("emits registration metadata with each command's correct Discord type", () => {
    const commands = getDiscordCommandRegistration(registryWithCommands());

    expect(commands).toEqual([
      {
        type: ApplicationCommandType.ChatInput,
        name: "ticket",
        description: "Find a ticket",
        dmPermission: false,
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "query",
            description: "Ticket query",
            autocomplete: true,
          },
        ],
      },
      { type: ApplicationCommandType.Message, name: "Open ticket" },
      { type: ApplicationCommandType.User, name: "User tickets" },
    ]);
  });

  it("sets global commands and best-effort clears stale guild commands", async () => {
    const globalSet = vi.fn().mockResolvedValue(undefined);
    const cleared = vi.fn().mockResolvedValue(undefined);
    const cleanupError = new Error("missing access");
    const rejected = vi.fn().mockRejectedValue(cleanupError);
    const warn = vi.fn();
    const client = {
      application: { commands: { set: globalSet } },
      guilds: {
        cache: new Map([
          ["guild-1", { id: "guild-1", commands: { set: cleared } }],
          ["guild-2", { id: "guild-2", commands: { set: rejected } }],
        ]),
      },
    } as unknown as Client<true>;
    const registry = registryWithCommands();

    await expect(
      registerDiscordCommands(client, registry, { logger: { warn } }),
    ).resolves.toBeUndefined();

    expect(globalSet).toHaveBeenCalledWith(
      getDiscordCommandRegistration(registry),
    );
    expect(cleared).toHaveBeenCalledWith([]);
    expect(rejected).toHaveBeenCalledWith([]);
    expect(warn).toHaveBeenCalledWith(
      "Failed to clear stale guild application commands",
      { guildId: "guild-2", error: cleanupError },
    );
  });

  it("replaces a guild catalog on restart to update and remove commands", async () => {
    let published: readonly unknown[] = [];
    const set = vi.fn(async (commands: readonly unknown[]) => {
      published = commands;
    });
    const guild = { id: "guild-1", commands: { set } };
    const fetch = vi.fn(async () => guild);
    const client = {
      guilds: { cache: new Map(), fetch },
    } as unknown as Client<true>;
    const target = { kind: "guild" as const, guildId: "guild-1" };
    const original = registryWithCommands();

    await registerDiscordCommands(client, original, { target });
    expect(published).toEqual(getDiscordCommandRegistration(original));
    expect(published).toContainEqual({
      type: ApplicationCommandType.Message,
      name: "Open ticket",
    });

    const restarted = createActionRegistry<TestContext>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    restarted.registerAction(
      action([
        slashCommand({
          name: "ticket",
          description: "Find an updated ticket",
          parse: () => "ticket",
        }),
        userContextMenu({ name: "User tickets", parse: () => "user" }),
      ]),
    );

    await registerDiscordCommands(client, restarted, { target });

    expect(set).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(published).toEqual(getDiscordCommandRegistration(restarted));
    expect(published).toContainEqual(
      expect.objectContaining({
        type: ApplicationCommandType.ChatInput,
        name: "ticket",
        description: "Find an updated ticket",
      }),
    );
    expect(published).not.toContainEqual(
      expect.objectContaining({
        type: ApplicationCommandType.Message,
        name: "Open ticket",
      }),
    );
  });
});
