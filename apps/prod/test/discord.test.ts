import { beforeEach, describe, expect, it, vi } from "vitest";

const discordMock = vi.hoisted(() => ({
  readyHandler: undefined as
    | undefined
    | ((client: { user: { id: string; tag: string } }) => void),
  login: vi.fn(async (token: string) => token),
  destroy: vi.fn(),
}));

vi.mock("discord.js", () => ({
  Events: { ClientReady: "clientReady" },
  GatewayIntentBits: { Guilds: 1 },
  Client: class {
    once(
      _event: string,
      handler: (client: { user: { id: string; tag: string } }) => void,
    ): this {
      discordMock.readyHandler = handler;
      return this;
    }

    off(): this {
      discordMock.readyHandler = undefined;
      return this;
    }

    login(token: string): Promise<string> {
      const result = discordMock.login(token);
      queueMicrotask(() => {
        discordMock.readyHandler?.({
          user: { id: "345678901234567890", tag: "Prod#0001" },
        });
      });
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
    discordMock.readyHandler = undefined;
    discordMock.login.mockClear();
    discordMock.destroy.mockClear();
  });

  it("resolves the ready identity and destroys the client once", async () => {
    const gateway = createDiscordGateway();

    await expect(gateway.connect("development-token")).resolves.toEqual({
      userId: "345678901234567890",
      tag: "Prod#0001",
    });
    expect(discordMock.login).toHaveBeenCalledWith("development-token");

    await gateway.close();
    await gateway.close();

    expect(discordMock.destroy).toHaveBeenCalledTimes(1);
    await expect(gateway.connect("development-token")).rejects.toThrow(
      "Discord gateway is closed",
    );
  });
});
