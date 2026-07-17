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
        ownerId: string | null;
        members: Map<
          string,
          { id: string; membershipState: number; role: string }
        >;
      },
  applicationFetch: vi.fn(),
  login: vi.fn(async (token: string) => token),
  destroy: vi.fn(),
  guildFetch: vi.fn(async (guildId: string) => ({ id: guildId })),
}));

vi.mock("discord.js", () => ({
  Events: {
    ClientReady: "clientReady",
    InteractionCreate: "interactionCreate",
    MessageCreate: "messageCreate",
  },
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    GuildMembers: 8,
  },
  TeamMemberMembershipState: { Invited: 1, Accepted: 2 },
  TeamMemberRole: {
    Admin: "admin",
    Developer: "developer",
    ReadOnly: "read_only",
  },
  Client: class {
    user = { id: "345678901234567890", tag: "Prod#0001" };
    application = {
      fetch: async () => {
        await discordMock.applicationFetch();
        return this.application;
      },
      get owner() {
        return discordMock.applicationOwner;
      },
    };
    guilds = { fetch: discordMock.guildFetch };

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
    discordMock.applicationFetch.mockReset().mockResolvedValue(undefined);
    discordMock.login.mockClear();
    discordMock.destroy.mockClear();
    discordMock.guildFetch.mockClear();
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

  it("does not resume ready side effects after aborting an owner lookup", async () => {
    let finishLookup: (() => void) | undefined;
    discordMock.applicationFetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishLookup = resolve;
        }),
    );
    const setApplicationOperatorUserIds = vi.fn();
    const refreshCommands = vi.fn(async () => undefined);
    const gateway = createDiscordGateway({
      configuredApplicationOperatorUserIds: ["123456789012345678"],
      applicationOperatorRefreshIntervalMs: 10,
      applicationOperatorMaxStalenessMs: 20,
      actions: {
        setApplicationOperatorUserIds,
        refreshCommands,
        handleInteraction: vi.fn(async () => undefined),
        handleError: vi.fn(),
      },
    });
    const controller = new AbortController();
    const reason = new DOMException("shutdown", "AbortError");

    const connection = gateway.connect("development-token", controller.signal);
    await vi.waitFor(() =>
      expect(setApplicationOperatorUserIds).toHaveBeenCalledWith([
        "123456789012345678",
      ]),
    );
    controller.abort(reason);
    await expect(connection).rejects.toBe(reason);

    finishLookup?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(setApplicationOperatorUserIds).toHaveBeenCalledTimes(1);
    expect(refreshCommands).not.toHaveBeenCalled();
    expect(discordMock.applicationFetch).toHaveBeenCalledTimes(1);
    expect(discordMock.destroy).toHaveBeenCalledOnce();
  });

  it("refreshes global commands and dispatches interactions", async () => {
    const refreshCommands = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => undefined);
    const handleInteraction = vi.fn(async () => undefined);
    const handleMessage = vi.fn(async () => true);
    const handleError = vi.fn();
    const setApplicationOperatorUserIds = vi.fn();
    const gateway = createDiscordGateway({
      actions: {
        setApplicationOperatorUserIds,
        refreshCommands,
        reconcile,
        handleInteraction,
        handleMessage,
        handleError,
      },
    });

    await gateway.connect("development-token", new AbortController().signal);

    expect(refreshCommands).toHaveBeenCalledWith(expect.anything());
    expect(reconcile).toHaveBeenCalledWith(expect.anything());
    expect(refreshCommands.mock.invocationCallOrder[0]).toBeLessThan(
      reconcile.mock.invocationCallOrder[0]!,
    );
    expect(setApplicationOperatorUserIds).toHaveBeenCalledWith([]);
    const interaction = { id: "interaction-1" };
    discordMock.interactionHandler?.(interaction);
    await vi.waitFor(() =>
      expect(handleInteraction).toHaveBeenCalledWith(interaction),
    );

    const message = { id: "message-1", content: "!ping" };
    discordMock.messageHandler?.(message);
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledWith(message));

    expect(discordMock.intents).toEqual([1, 8, 2, 4]);
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

    expect(discordMock.intents).toEqual([1, 8]);
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

  it("installs configured operators before application owner lookup completes", async () => {
    let finishLookup: (() => void) | undefined;
    discordMock.applicationOwner = { id: "223456789012345678" };
    discordMock.applicationFetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishLookup = resolve;
        }),
    );
    const setApplicationOperatorUserIds = vi.fn();
    const gateway = createDiscordGateway({
      configuredApplicationOperatorUserIds: ["123456789012345678"],
      actions: {
        setApplicationOperatorUserIds,
        refreshCommands: vi.fn(async () => undefined),
        handleInteraction: vi.fn(async () => undefined),
        handleError: vi.fn(),
      },
    });

    const connection = gateway.connect(
      "development-token",
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(setApplicationOperatorUserIds).toHaveBeenCalledWith([
        "123456789012345678",
      ]),
    );

    finishLookup?.();
    await expect(connection).resolves.toMatchObject({
      applicationOperatorUserIds: ["123456789012345678", "223456789012345678"],
    });
    expect(setApplicationOperatorUserIds).toHaveBeenLastCalledWith([
      "123456789012345678",
      "223456789012345678",
    ]);

    await gateway.close();
  });

  it("starts with configured operators when application owner lookup fails", async () => {
    const error = new Error("Discord application unavailable");
    discordMock.applicationFetch.mockRejectedValue(error);
    const setApplicationOperatorUserIds = vi.fn();
    const refreshCommands = vi.fn(async () => undefined);
    const handleError = vi.fn();
    const gateway = createDiscordGateway({
      configuredApplicationOperatorUserIds: ["123456789012345678"],
      actions: {
        setApplicationOperatorUserIds,
        refreshCommands,
        handleInteraction: vi.fn(async () => undefined),
        handleError,
      },
    });

    await expect(
      gateway.connect("development-token", new AbortController().signal),
    ).resolves.toMatchObject({
      applicationOperatorUserIds: ["123456789012345678"],
    });
    expect(setApplicationOperatorUserIds).toHaveBeenCalledWith([
      "123456789012345678",
    ]);
    expect(refreshCommands).toHaveBeenCalledOnce();
    expect(handleError).toHaveBeenCalledWith(error);

    await gateway.close();
  });

  it("grants accepted Team operators but fails closed for read-only and invited members", async () => {
    discordMock.applicationOwner = {
      ownerId: "223456789012345678",
      members: new Map([
        [
          "owner",
          {
            id: "223456789012345678",
            membershipState: 2,
            role: "read_only",
          },
        ],
        [
          "admin",
          {
            id: "323456789012345678",
            membershipState: 2,
            role: "admin",
          },
        ],
        [
          "developer",
          {
            id: "423456789012345678",
            membershipState: 2,
            role: "developer",
          },
        ],
        [
          "read-only",
          {
            id: "523456789012345678",
            membershipState: 2,
            role: "read_only",
          },
        ],
        [
          "invited",
          {
            id: "623456789012345678",
            membershipState: 1,
            role: "admin",
          },
        ],
        [
          "unknown",
          {
            id: "723456789012345678",
            membershipState: 2,
            role: "future_role",
          },
        ],
      ]),
    };
    const gateway = createDiscordGateway({
      configuredApplicationOperatorUserIds: ["123456789012345678"],
    });

    await expect(
      gateway.connect("development-token", new AbortController().signal),
    ).resolves.toMatchObject({
      applicationOperatorUserIds: [
        "123456789012345678",
        "223456789012345678",
        "323456789012345678",
        "423456789012345678",
      ],
    });
  });

  it("refreshes Team authority and expires it after bounded staleness", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const setApplicationOperatorUserIds = vi.fn();
    const handleError = vi.fn();
    discordMock.applicationOwner = {
      ownerId: "223456789012345678",
      members: new Map([
        [
          "admin",
          {
            id: "223456789012345678",
            membershipState: 2,
            role: "admin",
          },
        ],
      ]),
    };
    const gateway = createDiscordGateway({
      configuredApplicationOperatorUserIds: ["123456789012345678"],
      applicationOperatorRefreshIntervalMs: 100,
      applicationOperatorMaxStalenessMs: 250,
      actions: {
        setApplicationOperatorUserIds,
        refreshCommands: vi.fn(async () => undefined),
        handleInteraction: vi.fn(async () => undefined),
        handleError,
      },
    });

    try {
      await gateway.connect("development-token", new AbortController().signal);
      expect(setApplicationOperatorUserIds).toHaveBeenLastCalledWith([
        "123456789012345678",
        "223456789012345678",
      ]);

      discordMock.applicationOwner = {
        ownerId: "323456789012345678",
        members: new Map([
          [
            "former-admin",
            {
              id: "223456789012345678",
              membershipState: 2,
              role: "read_only",
            },
          ],
        ]),
      };
      await vi.advanceTimersByTimeAsync(100);
      expect(setApplicationOperatorUserIds).toHaveBeenLastCalledWith([
        "123456789012345678",
      ]);

      discordMock.applicationOwner = {
        ownerId: "223456789012345678",
        members: new Map([
          [
            "admin",
            {
              id: "223456789012345678",
              membershipState: 2,
              role: "admin",
            },
          ],
        ]),
      };
      await vi.advanceTimersByTimeAsync(100);
      expect(setApplicationOperatorUserIds).toHaveBeenLastCalledWith([
        "123456789012345678",
        "223456789012345678",
      ]);

      discordMock.applicationFetch.mockRejectedValue(
        new Error("Discord unavailable"),
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(handleError).toHaveBeenCalled();
      expect(setApplicationOperatorUserIds).toHaveBeenLastCalledWith([
        "123456789012345678",
      ]);

      await gateway.close();
      const callsAfterClose = setApplicationOperatorUserIds.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(setApplicationOperatorUserIds).toHaveBeenCalledTimes(
        callsAfterClose,
      );
    } finally {
      await gateway.close();
      vi.useRealTimers();
    }
  });
});
