import { beforeEach, describe, expect, it, vi } from "vitest";

const discordMock = vi.hoisted(() => ({
  autoReady: true,
  readyHandler: undefined as undefined | ((client: unknown) => void),
  interactionHandler: undefined as undefined | ((interaction: unknown) => void),
  guildCommandSet: vi.fn(async (commands: unknown) => commands),
  login: vi.fn(async (token: string) => token),
  destroy: vi.fn(),
}));

vi.mock("discord.js", () => ({
  Events: {
    ClientReady: "clientReady",
    InteractionCreate: "interactionCreate",
  },
  GatewayIntentBits: { Guilds: 1 },
  Client: class {
    user = { id: "345678901234567890", tag: "Prod#0001" };
    guilds = {
      cache: new Map([
        [
          "234567890123456789",
          { commands: { set: discordMock.guildCommandSet } },
        ],
      ]),
      fetch: vi.fn(),
    };

    once(_event: string, handler: (client: unknown) => void): this {
      discordMock.readyHandler = handler;
      return this;
    }

    on(_event: string, handler: (interaction: unknown) => void): this {
      discordMock.interactionHandler = handler;
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
    discordMock.guildCommandSet.mockClear();
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

  it("registers development-guild commands and dispatches interactions", async () => {
    const commands = [{ name: "ping", description: "Ping" }];
    const handleInteraction = vi.fn(async () => undefined);
    const handleError = vi.fn();
    const gateway = createDiscordGateway({
      actions: { commands, handleInteraction, handleError },
      developmentGuildId: "234567890123456789",
    });

    await gateway.connect("development-token", new AbortController().signal);

    expect(discordMock.guildCommandSet).toHaveBeenCalledWith(commands);
    const interaction = { id: "interaction-1" };
    discordMock.interactionHandler?.(interaction);
    await vi.waitFor(() =>
      expect(handleInteraction).toHaveBeenCalledWith(interaction),
    );
    expect(handleError).not.toHaveBeenCalled();
  });
});
