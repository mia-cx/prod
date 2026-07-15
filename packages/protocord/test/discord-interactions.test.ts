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
const noMentions = { parse: [], repliedUser: false };

function context(): TestContext {
  return { events: [], invocations: [] };
}

function action<AuthorizationCheck = never>(
  triggers: readonly TriggerDefinition<
    string,
    TestContext,
    AuthorizationCheck
  >[],
  overrides: Partial<
    Action<string, string, TestContext, AuthorizationCheck>
  > = {},
): Action<string, string, TestContext, AuthorizationCheck> {
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
    availability: (testContext) => {
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
    deleteReply: vi.fn().mockResolvedValue(undefined),
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
            access: { kind: "public" },
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

  it("responds with no autocomplete choices when completion fails", async () => {
    const failure = new Error("completion failed");
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
            access: { kind: "public" },
            complete: () => Promise.reject(failure),
          },
        }),
      ]),
    );
    const respond = vi.fn().mockResolvedValue(undefined);
    const event = interaction("autocomplete", "ticket", { respond });

    await expect(
      dispatchDiscordAutocomplete(registry, event, context()),
    ).rejects.toBe(failure);

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith([]);
  });

  it("preserves autocomplete and fallback response failures", async () => {
    const completionFailure = new Error("completion failed");
    const responseFailure = new Error("response failed");
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
            access: { kind: "public" },
            complete: () => Promise.reject(completionFailure),
          },
        }),
      ]),
    );
    const respond = vi.fn().mockRejectedValue(responseFailure);

    await expect(
      dispatchDiscordAutocomplete(
        registry,
        interaction("autocomplete", "ticket", { respond }),
        context(),
      ),
    ).rejects.toMatchObject({
      errors: [completionFailure, responseFailure],
      cause: completionFailure,
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith([]);
  });

  it("reports a missing autocomplete authorizer after responding safely", async () => {
    const readiness = vi.fn(() => ({ available: true as const }));
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
            access: {
              kind: "authorized",
              authorization: () => ({ permission: "tickets.view" }),
            },
            readiness,
            complete,
          },
        }),
      ]),
    );
    const respond = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchDiscordAutocomplete(
        registry,
        interaction("autocomplete", "ticket", { respond }),
        context(),
      ),
    ).rejects.toThrow(
      "Autocomplete for ticket requires authorization but no authorizer was provided",
    );
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith([]);
    expect(readiness).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
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
            access: {
              kind: "authorized",
              authorization: () => ({ permission: "tickets.view" }),
            },
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

  it("checks autocomplete readiness only after access succeeds", async () => {
    const readiness = vi.fn(() => ({
      available: false as const,
      reason: "resource is paused",
    }));
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
            access: {
              kind: "authorized",
              authorization: () => ({ permission: "tickets.view" }),
            },
            readiness,
            complete,
          },
        }),
      ]),
    );
    const deniedRespond = vi.fn().mockResolvedValue(undefined);

    await dispatchDiscordAutocomplete(
      registry,
      interaction("autocomplete", "ticket", { respond: deniedRespond }),
      context(),
      () => ({ authorized: false, reason: "private" }),
    );

    expect(readiness).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();

    const authorizedRespond = vi.fn().mockResolvedValue(undefined);
    await dispatchDiscordAutocomplete(
      registry,
      interaction("autocomplete", "ticket", { respond: authorizedRespond }),
      context(),
      () => ({ authorized: true }),
    );

    expect(readiness).toHaveBeenCalledOnce();
    expect(authorizedRespond).toHaveBeenCalledWith([]);
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
      allowedMentions: noMentions,
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

  it("lets a custom presenter own acknowledgement when deferral is disabled", async () => {
    const present = vi.fn();
    const registry = createActionRegistry<TestContext>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    registry.registerAction(
      action([
        slashCommand({
          name: "custom-response",
          description: "Use a custom response",
          acknowledgement: "none",
          parse: () => "custom",
          present,
        }),
      ]),
    );
    const event = interaction("slash", "custom-response");
    const command = event as ChatInputCommandInteraction;
    const testContext = context();

    await dispatchDiscordInteraction(registry, event, testContext);

    expect(command.deferReply).not.toHaveBeenCalled();
    expect(present).toHaveBeenCalledWith(
      { status: "executed", output: "CUSTOM" },
      command,
      testContext,
    );
    expect(command.reply).not.toHaveBeenCalled();
  });

  it("publishes only an executed result for a public trigger", async () => {
    const registry = createActionRegistry<TestContext>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    registry.registerAction(
      action([
        slashCommand({
          name: "public-result",
          description: "Publish successful output",
          visibility: "public",
          parse: () => "public result",
        }),
      ]),
    );
    const event = interaction("slash", "public-result");
    const command = event as ChatInputCommandInteraction;

    await dispatchDiscordInteraction(registry, event, context());

    expect(command.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    const reply = {
      content: "PUBLIC RESULT",
      allowedMentions: noMentions,
    };
    expect(command.editReply).toHaveBeenCalledWith(reply);
    expect(command.followUp).toHaveBeenCalledWith(reply);
    expect(command.deleteReply).toHaveBeenCalledOnce();
    expect(
      vi.mocked(command.editReply).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(command.followUp).mock.invocationCallOrder[0]!);
    expect(
      vi.mocked(command.followUp).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(command.deleteReply).mock.invocationCallOrder[0]!);
  });

  it.each([
    [
      "slash",
      slashCommand({
        name: "protected",
        description: "Protected slash command",
        visibility: "public",
        parse: () => "slash",
      }),
    ],
    [
      "message",
      messageContextMenu({
        name: "Protected message",
        visibility: "public",
        parse: () => "message",
      }),
    ],
    [
      "user",
      userContextMenu({
        name: "Protected user",
        visibility: "public",
        parse: () => "user",
      }),
    ],
  ] as const)(
    "keeps unavailable public %s commands private",
    async (kind, trigger) => {
      const registry = createActionRegistry<TestContext>({
        providers: createDiscordInteractionProviders<TestContext>(),
      });
      registry.registerAction(
        action([trigger], {
          availability: () => ({ available: false, reason: "private state" }),
        }),
      );
      const event = interaction(kind, trigger.name);
      const command = event as ChatInputCommandInteraction;

      await dispatchDiscordInteraction(registry, event, context());

      expect(command.deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(command.editReply).toHaveBeenCalledWith({
        content: "private state",
        allowedMentions: noMentions,
      });
      expect(command.deleteReply).not.toHaveBeenCalled();
      expect(command.followUp).not.toHaveBeenCalled();
    },
  );

  it("keeps unauthorized public commands private", async () => {
    const trigger = slashCommand({
      name: "protected-public",
      description: "Protected public command",
      visibility: "public",
      parse: () => "protected",
    });
    const registry = createActionRegistry<TestContext, TestCheck>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    registry.registerAction({
      ...action([trigger]),
      authorization: () => ({ permission: "protected.run" }),
    });
    const event = interaction("slash", trigger.name);
    const command = event as ChatInputCommandInteraction;

    await dispatchDiscordInteraction(registry, event, context(), () => ({
      authorized: false,
      reason: "private denial",
    }));

    expect(command.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(command.editReply).toHaveBeenCalledWith({
      content: "private denial",
      allowedMentions: noMentions,
    });
    expect(command.deleteReply).not.toHaveBeenCalled();
    expect(command.followUp).not.toHaveBeenCalled();
  });

  it("keeps failed public commands private", async () => {
    const trigger = slashCommand({
      name: "failing-public",
      description: "Failing public command",
      visibility: "public",
      parse: () => "failing",
    });
    const registry = createActionRegistry<TestContext>({
      providers: createDiscordInteractionProviders<TestContext>(),
    });
    registry.registerAction(
      action([trigger], {
        execute: async () => {
          throw new Error("boom");
        },
      }),
    );
    const event = interaction("slash", trigger.name);
    const command = event as ChatInputCommandInteraction;

    await dispatchDiscordInteraction(registry, event, context());

    expect(command.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(command.editReply).toHaveBeenCalledWith({
      content: "Something went wrong while running this action.",
      allowedMentions: noMentions,
    });
    expect(command.deleteReply).not.toHaveBeenCalled();
    expect(command.followUp).not.toHaveBeenCalled();
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

  it("clears every guild catalog before publishing global commands", async () => {
    const globalSet = vi.fn().mockResolvedValue(undefined);
    const firstGuildSet = vi.fn().mockResolvedValue(undefined);
    const secondGuildSet = vi.fn().mockResolvedValue(undefined);
    const client = {
      application: { commands: { set: globalSet } },
      guilds: {
        cache: new Map([
          ["guild-1", { id: "guild-1", commands: { set: firstGuildSet } }],
          ["guild-2", { id: "guild-2", commands: { set: secondGuildSet } }],
        ]),
      },
    } as unknown as Client<true>;
    const registry = registryWithCommands();

    await expect(
      registerDiscordCommands(client, registry),
    ).resolves.toBeUndefined();

    expect(firstGuildSet).toHaveBeenCalledWith([]);
    expect(secondGuildSet).toHaveBeenCalledWith([]);
    expect(globalSet).toHaveBeenCalledWith(
      getDiscordCommandRegistration(registry),
    );
    expect(firstGuildSet.mock.invocationCallOrder[0]).toBeLessThan(
      globalSet.mock.invocationCallOrder[0]!,
    );
    expect(secondGuildSet.mock.invocationCallOrder[0]).toBeLessThan(
      globalSet.mock.invocationCallOrder[0]!,
    );
  });

  it("does not publish global commands when a stale guild catalog cannot be cleared", async () => {
    const cleanupError = new Error("missing access");
    const globalSet = vi.fn().mockResolvedValue(undefined);
    const client = {
      application: { commands: { set: globalSet } },
      guilds: {
        cache: new Map([
          [
            "guild-1",
            {
              id: "guild-1",
              commands: { set: vi.fn().mockRejectedValue(cleanupError) },
            },
          ],
        ]),
      },
    } as unknown as Client<true>;

    await expect(
      registerDiscordCommands(client, registryWithCommands()),
    ).rejects.toBe(cleanupError);
    expect(globalSet).not.toHaveBeenCalled();
  });

  it("clears global commands before publishing a guild catalog", async () => {
    const globalSet = vi.fn().mockResolvedValue(undefined);
    const guildSet = vi.fn().mockResolvedValue(undefined);
    const guild = { id: "guild-1", commands: { set: guildSet } };
    const client = {
      application: { commands: { set: globalSet } },
      guilds: { cache: new Map([["guild-1", guild]]) },
    } as unknown as Client<true>;
    const registry = registryWithCommands();

    await registerDiscordCommands(client, registry, {
      target: { kind: "guild", guildId: "guild-1" },
    });

    expect(globalSet).toHaveBeenCalledWith([]);
    expect(guildSet).toHaveBeenCalledWith(
      getDiscordCommandRegistration(registry),
    );
    expect(globalSet.mock.invocationCallOrder[0]).toBeLessThan(
      guildSet.mock.invocationCallOrder[0]!,
    );
  });

  it("does not publish guild commands when the global catalog cannot be cleared", async () => {
    const cleanupError = new Error("missing access");
    const guildSet = vi.fn().mockResolvedValue(undefined);
    const client = {
      application: {
        commands: { set: vi.fn().mockRejectedValue(cleanupError) },
      },
      guilds: {
        cache: new Map([
          ["guild-1", { id: "guild-1", commands: { set: guildSet } }],
        ]),
      },
    } as unknown as Client<true>;

    await expect(
      registerDiscordCommands(client, registryWithCommands(), {
        target: { kind: "guild", guildId: "guild-1" },
      }),
    ).rejects.toBe(cleanupError);
    expect(guildSet).not.toHaveBeenCalled();
  });

  it("replaces a guild catalog on restart to update and remove commands", async () => {
    let published: readonly unknown[] = [];
    const set = vi.fn(async (commands: readonly unknown[]) => {
      published = commands;
    });
    const guild = { id: "guild-1", commands: { set } };
    const fetch = vi.fn(async () => guild);
    const client = {
      application: {
        commands: { set: vi.fn().mockResolvedValue(undefined) },
      },
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
