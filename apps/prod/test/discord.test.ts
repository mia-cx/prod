import { beforeEach, describe, expect, it, vi } from "vitest";

const discordMock = vi.hoisted(() => ({
  autoReady: true,
  readyHandler: undefined as undefined | ((client: unknown) => void),
  interactionHandler: undefined as undefined | ((interaction: unknown) => void),
  messageHandler: undefined as undefined | ((message: unknown) => void),
  intents: [] as number[],
  applicationOwner: null as
    | null
    | { id: string }
    | {
        members: Map<string, { id: string; membershipState: number }>;
      },
  applicationFetch: vi.fn(),
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
  TeamMemberMembershipState: { Invited: 1, Accepted: 2 },
  Client: class {
    user = { id: "345678901234567890", tag: "Prod#0001" };
    application = {
      fetch: async () => {
        discordMock.applicationFetch();
        return this.application;
      },
      get owner() {
        return discordMock.applicationOwner;
      },
    };

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
    discordMock.applicationOwner = null;
    discordMock.applicationFetch.mockClear();
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
        applicationOperatorUserIds: [],
      },
    );
    expect(discordMock.applicationFetch).toHaveBeenCalledOnce();
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

  it("stays abortable while application commands are refreshing", async () => {
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

  it("refreshes global commands and dispatches interactions", async () => {
    const refreshCommands = vi.fn(async () => undefined);
    const handleInteraction = vi.fn(async () => undefined);
    const handleMessage = vi.fn(async () => true);
    const handleError = vi.fn();
    const setApplicationOperatorUserIds = vi.fn();
    const gateway = createDiscordGateway({
      actions: {
        setApplicationOperatorUserIds,
        refreshCommands,
        handleInteraction,
        handleMessage,
        handleError,
      },
    });

    await gateway.connect("development-token", new AbortController().signal);

    expect(refreshCommands).toHaveBeenCalledWith(expect.anything());
    expect(setApplicationOperatorUserIds).toHaveBeenCalledWith([]);
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

  it("does not request message intents without a text capability", async () => {
    const gateway = createDiscordGateway({
      actions: {
        refreshCommands: vi.fn(async () => undefined),
        handleInteraction: vi.fn(async () => undefined),
        handleError: vi.fn(),
      },
    });

    await gateway.connect("development-token", new AbortController().signal);

    expect(discordMock.intents).toEqual([1]);
    expect(discordMock.messageHandler).toBeUndefined();
  });

  it("unions configured IDs with an individual application owner", async () => {
    discordMock.applicationOwner = { id: "223456789012345678" };
    const gateway = createDiscordGateway({
      configuredApplicationOperatorUserIds: [
        "123456789012345678",
        "223456789012345678",
      ],
    });

    await expect(
      gateway.connect("development-token", new AbortController().signal),
    ).resolves.toMatchObject({
      applicationOperatorUserIds: ["123456789012345678", "223456789012345678"],
    });
  });

  it("grants accepted Team members but excludes pending invitees", async () => {
    discordMock.applicationOwner = {
      members: new Map([
        ["accepted", { id: "223456789012345678", membershipState: 2 }],
        ["invited", { id: "323456789012345678", membershipState: 1 }],
      ]),
    };
    const gateway = createDiscordGateway({
      configuredApplicationOperatorUserIds: ["123456789012345678"],
    });

    await expect(
      gateway.connect("development-token", new AbortController().signal),
    ).resolves.toMatchObject({
      applicationOperatorUserIds: ["123456789012345678", "223456789012345678"],
    });
  });
});
