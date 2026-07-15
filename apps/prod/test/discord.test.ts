import { beforeEach, describe, expect, it, vi } from "vitest";

const discordMock = vi.hoisted(() => ({
  autoReady: true,
  readyHandler: undefined as undefined | ((client: unknown) => void),
  interactionHandler: undefined as undefined | ((interaction: unknown) => void),
  messageHandler: undefined as undefined | ((message: unknown) => void),
  intents: [] as number[],
  login: vi.fn(async (token: string) => token),
  destroy: vi.fn(),
}));

vi.mock("discord.js", () => ({
  Events: {
    ClientReady: "clientReady",
    InteractionCreate: "interactionCreate",
    MessageCreate: "messageCreate",
  },
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  Client: class {
    user = { id: "345678901234567890", tag: "Prod#0001" };

    constructor(options: { intents: number[] }) {
      discordMock.intents = options.intents;
    }

    once(_event: string, handler: (client: unknown) => void): this {
      discordMock.readyHandler = handler;
      return this;
    }

    on(event: string, handler: (event: unknown) => void): this {
      if (event === "interactionCreate") {
        discordMock.interactionHandler = handler;
      } else if (event === "messageCreate") {
        discordMock.messageHandler = handler;
      }
      return this;
    }

    off(): this {
      discordMock.readyHandler = undefined;
      return this;
    }

    login(token: string): Promise<string> {
      const result = discordMock.login(token);
      if (discordMock.autoReady) {
        queueMicrotask(() => {
          discordMock.readyHandler?.(this);
        });
      }
      return result;
    }

    destroy(): void {
      discordMock.destroy();
    }
  },
}));

import { createDiscordGateway } from "../src/discord.js";

describe("createDiscordGateway", () => {
  beforeEach(() => {
    discordMock.autoReady = true;
    discordMock.readyHandler = undefined;
    discordMock.interactionHandler = undefined;
    discordMock.messageHandler = undefined;
    discordMock.intents = [];
    discordMock.login.mockClear();
    discordMock.destroy.mockClear();
  });

  it("resolves the ready identity and destroys the client once", async () => {
    const gateway = createDiscordGateway();
    const signal = new AbortController().signal;

    await expect(gateway.connect("development-token", signal)).resolves.toEqual(
      {
        userId: "345678901234567890",
        tag: "Prod#0001",
      },
    );
    expect(discordMock.login).toHaveBeenCalledWith("development-token");

    await gateway.close();
    await gateway.close();

    expect(discordMock.destroy).toHaveBeenCalledTimes(1);
    await expect(gateway.connect("development-token", signal)).rejects.toThrow(
      "Discord gateway is closed",
    );
  });

  it("aborts a pending login and destroys the client once", async () => {
    discordMock.autoReady = false;
    const gateway = createDiscordGateway();
    const controller = new AbortController();
    const reason = new DOMException("shutdown", "AbortError");

    const connection = gateway.connect("development-token", controller.signal);
    controller.abort(reason);

    await expect(connection).rejects.toBe(reason);
    await gateway.close();
    expect(discordMock.destroy).toHaveBeenCalledTimes(1);
  });

  it("stays abortable while development commands are refreshing", async () => {
    let finishRefresh: (() => void) | undefined;
    const refreshCommands = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const gateway = createDiscordGateway({
      actions: {
        refreshCommands,
        handleInteraction: vi.fn(async () => undefined),
        handleMessage: vi.fn(async () => false),
        handleError: vi.fn(),
      },
      developmentGuildId: "234567890123456789",
    });
    const controller = new AbortController();
    const reason = new DOMException("shutdown", "AbortError");

    const connection = gateway.connect("development-token", controller.signal);
    await vi.waitFor(() => expect(refreshCommands).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(connection).rejects.toBe(reason);
    expect(discordMock.destroy).toHaveBeenCalledTimes(1);

    finishRefresh?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await gateway.close();
    expect(discordMock.destroy).toHaveBeenCalledTimes(1);
  });

  it("refreshes development-guild commands and dispatches interactions", async () => {
    const refreshCommands = vi.fn(async () => undefined);
    const handleInteraction = vi.fn(async () => undefined);
    const handleMessage = vi.fn(async () => true);
    const handleError = vi.fn();
    const gateway = createDiscordGateway({
      actions: {
        refreshCommands,
        handleInteraction,
        handleMessage,
        handleError,
      },
      developmentGuildId: "234567890123456789",
    });

    await gateway.connect("development-token", new AbortController().signal);

    expect(refreshCommands).toHaveBeenCalledWith(
      expect.anything(),
      "234567890123456789",
    );
    const interaction = { id: "interaction-1" };
    discordMock.interactionHandler?.(interaction);
    await vi.waitFor(() =>
      expect(handleInteraction).toHaveBeenCalledWith(interaction),
    );

    const message = { id: "message-1", content: "!ping" };
    discordMock.messageHandler?.(message);
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledWith(message));

    expect(discordMock.intents).toEqual([1, 2, 4]);
    expect(handleError).not.toHaveBeenCalled();
  });
});
