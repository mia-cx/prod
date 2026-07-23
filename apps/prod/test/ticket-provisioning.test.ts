import {
  ChannelType,
  Collection,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  RESTJSONErrorCodes,
  Routes,
  type Guild,
  type GuildMember,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { openDatabase } from "../src/database.js";
import type { GuildSettingsStore } from "../src/guild-settings.js";
import { createGuildOperationExecutor } from "../src/guild-operation.js";
import { applyMigrations } from "../src/migrations.js";
import {
  createTicketProvisioningDiscord,
  createTicketProvisioningService,
  REPORTER_TICKET_HUB_OVERWRITE,
  sanitizeTicketSummary,
  TicketSetupRequiredError,
  ticketOpeningInstructions,
  type TicketProvisioningDiscord,
} from "../src/ticket-provisioning.js";
import {
  createSqliteTicketStore,
  TicketStateTransitionError,
} from "../src/tickets.js";
import type { ReporterHubAccessSnapshot } from "../src/reporter-hub-access.js";

const guild = { id: "guild-1" } as Guild;
const settings = {
  get: async (guildId: string) => ({
    guildId,
    initialized: true,
    hubChannelId: "hub-1",
    assistantIdentity: "Prod",
    tone: "friendly",
  }),
} as GuildSettingsStore;
const emptyAccessSnapshot: ReporterHubAccessSnapshot = {
  version: 1,
  overwriteExisted: false,
  permissions: {
    ViewChannel: "unset",
    ReadMessageHistory: "unset",
    SendMessagesInThreads: "unset",
    UseApplicationCommands: "unset",
    SendMessages: "unset",
    CreatePublicThreads: "unset",
    CreatePrivateThreads: "unset",
    ManageThreads: "unset",
  },
};
const reporter = { id: "reporter-1" } as GuildMember;

const discordFixture = (
  overrides: Partial<TicketProvisioningDiscord> = {},
): TicketProvisioningDiscord => ({
  validateReporter: vi.fn().mockResolvedValue(reporter),
  captureReporterAccess: vi.fn().mockResolvedValue(emptyAccessSnapshot),
  grantReporterAccess: vi.fn().mockResolvedValue(undefined),
  restoreReporterAccess: vi.fn().mockResolvedValue(undefined),
  findTicketThread: vi.fn().mockResolvedValue(undefined),
  createTicketThread: vi.fn().mockResolvedValue("thread-1"),
  prepareTicketThread: vi.fn().mockResolvedValue({
    wasArchived: false,
    reporterWasMember: false,
  }),
  addReporter: vi.fn().mockResolvedValue(undefined),
  upsertOpeningInstructions: vi.fn().mockResolvedValue({
    messageId: "message-1",
    created: true,
  }),
  updateTicketThreadName: vi.fn().mockResolvedValue(undefined),
  reconcileTicketPresentation: vi.fn().mockResolvedValue(undefined),
  rollbackTicketThread: vi.fn().mockResolvedValue(undefined),
  deleteTicketThread: vi.fn().mockResolvedValue(undefined),
  closeTicketThread: vi.fn().mockResolvedValue(undefined),
  reopenTicketThread: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe("ticket provisioning", () => {
  it("closes the final reporter ticket, archives its thread, and releases hub access", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => "ticket-close-final",
    });
    try {
      const ticket = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });

      await expect(
        service.close(guild, ticket.id, { actorUserId: "staff-1" }),
      ).resolves.toMatchObject({ status: "closed", triageStatus: "paused" });
      expect(discord.closeTicketThread).toHaveBeenCalledWith(
        guild,
        expect.objectContaining({ id: ticket.id, status: "closed" }),
      );
      expect(discord.restoreReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-1",
        "reporter-1",
        emptyAccessSnapshot,
      );
      await expect(store.getReporterAccess(ticket)).resolves.toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("retains shared reporter access until their other open ticket closes", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    let thread = 0;
    const discord = discordFixture({
      createTicketThread: vi.fn(async () => `thread-shared-${++thread}`),
      upsertOpeningInstructions: vi.fn(async (_guild, ticket) => ({
        messageId: `message-${ticket.id}`,
        created: true,
      })),
    });
    let id = 0;
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => `ticket-shared-${++id}`,
    });
    try {
      const first = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      const second = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "report",
      });
      vi.mocked(discord.restoreReporterAccess).mockClear();

      await service.close(guild, first.id);
      expect(discord.restoreReporterAccess).not.toHaveBeenCalled();
      await expect(store.getReporterAccess(first)).resolves.toEqual(
        emptyAccessSnapshot,
      );

      await service.close(guild, second.id);
      expect(discord.restoreReporterAccess).toHaveBeenCalledOnce();
    } finally {
      connection.close();
    }
  });

  it("restores reporter access and thread state before reopening paused", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => "ticket-reopen",
    });
    try {
      const ticket = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      await service.close(guild, ticket.id);
      vi.mocked(discord.grantReporterAccess).mockClear();

      await expect(
        service.reopen(guild, ticket.id, { actorUserId: "staff-2" }),
      ).resolves.toMatchObject({ status: "open", triageStatus: "paused" });
      expect(discord.grantReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-1",
        reporter,
      );
      expect(discord.reopenTicketThread).toHaveBeenCalledWith(
        guild,
        expect.objectContaining({ id: ticket.id }),
      );
      expect(discord.addReporter).toHaveBeenCalledWith(
        guild,
        ticket.threadId,
        ticket.reporterUserId,
      );
      await expect(store.getReporterAccess(ticket)).resolves.toEqual(
        emptyAccessSnapshot,
      );
    } finally {
      connection.close();
    }
  });

  it("compensates a failed final close back to open", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture({
      closeTicketThread: vi.fn().mockRejectedValue(new Error("thread missing")),
    });
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => "ticket-close-failure",
    });
    try {
      const ticket = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });

      await expect(service.close(guild, ticket.id)).rejects.toThrow(
        "thread missing",
      );
      await expect(store.get(ticket.id)).resolves.toMatchObject({
        status: "open",
        triageStatus: "paused",
      });
      await expect(store.getReporterAccess(ticket)).resolves.toEqual(
        emptyAccessSnapshot,
      );
      expect(discord.reopenTicketThread).toHaveBeenCalledWith(
        guild,
        expect.objectContaining({ id: ticket.id }),
      );
      expect(discord.restoreReporterAccess).not.toHaveBeenCalled();
    } finally {
      connection.close();
    }
  });

  it("compensates a failed close back to open when shared access must remain", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    let thread = 0;
    const closeTicketThread = vi
      .fn()
      .mockRejectedValueOnce(new Error("cannot lock"))
      .mockResolvedValue(undefined);
    const discord = discordFixture({
      createTicketThread: vi.fn(async () => `thread-compensate-${++thread}`),
      upsertOpeningInstructions: vi.fn(async (_guild, ticket) => ({
        messageId: `message-${ticket.id}`,
        created: true,
      })),
      closeTicketThread,
    });
    let id = 0;
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => `ticket-close-compensate-${++id}`,
    });
    try {
      const first = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "report",
      });

      await expect(service.close(guild, first.id)).rejects.toThrow(
        "cannot lock",
      );
      await expect(store.get(first.id)).resolves.toMatchObject({
        status: "open",
        triageStatus: "paused",
      });
      expect(discord.reopenTicketThread).toHaveBeenCalledWith(
        guild,
        expect.objectContaining({ id: first.id }),
      );
      expect(discord.restoreReporterAccess).not.toHaveBeenCalled();
    } finally {
      connection.close();
    }
  });

  it("does not reopen a settled ticket when a duplicate close cannot lock its thread", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    let thread = 0;
    const discord = discordFixture({
      createTicketThread: vi.fn(async () => `thread-duplicate-${++thread}`),
      upsertOpeningInstructions: vi.fn(async (_guild, ticket) => ({
        messageId: `message-${ticket.id}`,
        created: true,
      })),
    });
    let id = 0;
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => `ticket-duplicate-${++id}`,
    });
    try {
      const first = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "report",
      });
      await service.close(guild, first.id);
      vi.mocked(discord.reopenTicketThread).mockClear();
      vi.mocked(discord.closeTicketThread).mockRejectedValueOnce(
        new Error("cannot lock"),
      );

      await expect(service.close(guild, first.id)).rejects.toThrow(
        "cannot lock",
      );
      await expect(store.get(first.id)).resolves.toMatchObject({
        status: "closed",
        triageStatus: "paused",
      });
      expect(discord.reopenTicketThread).not.toHaveBeenCalled();
    } finally {
      connection.close();
    }
  });

  it("compensates reporter access and thread state when reopen fails", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => "ticket-reopen-failure",
    });
    try {
      const ticket = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      await service.close(guild, ticket.id);
      vi.mocked(discord.restoreReporterAccess).mockClear();
      vi.mocked(discord.closeTicketThread).mockClear();
      vi.mocked(discord.reopenTicketThread).mockRejectedValueOnce(
        new Error("cannot unlock"),
      );

      await expect(service.reopen(guild, ticket.id)).rejects.toThrow(
        "cannot unlock",
      );
      await expect(store.get(ticket.id)).resolves.toMatchObject({
        status: "closed",
        triageStatus: "paused",
      });
      await expect(store.getReporterAccess(ticket)).resolves.toBeUndefined();
      expect(discord.closeTicketThread).toHaveBeenCalledWith(
        guild,
        expect.objectContaining({ id: ticket.id }),
      );
      expect(discord.restoreReporterAccess).toHaveBeenCalledOnce();
    } finally {
      connection.close();
    }
  });

  it("restores the current shared overwrite when reopen fails", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    let thread = 0;
    const restrictedSnapshot: ReporterHubAccessSnapshot = {
      ...emptyAccessSnapshot,
      overwriteExisted: true,
      permissions: {
        ...emptyAccessSnapshot.permissions,
        SendMessagesInThreads: "deny",
      },
    };
    const discord = discordFixture({
      createTicketThread: vi.fn(async () => `thread-shared-reopen-${++thread}`),
      upsertOpeningInstructions: vi.fn(async (_guild, ticket) => ({
        messageId: `message-${ticket.id}`,
        created: true,
      })),
    });
    let id = 0;
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => `ticket-shared-reopen-${++id}`,
    });
    try {
      const first = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "report",
      });
      await service.close(guild, first.id);
      vi.mocked(discord.captureReporterAccess).mockResolvedValueOnce(
        restrictedSnapshot,
      );
      vi.mocked(discord.restoreReporterAccess).mockClear();
      vi.mocked(discord.addReporter).mockRejectedValueOnce(
        new Error("cannot add reporter"),
      );

      await expect(service.reopen(guild, first.id)).rejects.toThrow(
        "cannot add reporter",
      );
      expect(discord.restoreReporterAccess).toHaveBeenCalledWith(
        guild,
        first.hubChannelId,
        first.reporterUserId,
        restrictedSnapshot,
      );
      await expect(store.getReporterAccess(first)).resolves.toEqual(
        emptyAccessSnapshot,
      );
    } finally {
      connection.close();
    }
  });

  it("does not compensate Discord when the serialized reopen authorization fails", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => "ticket-reopen-denied",
    });
    try {
      const ticket = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      await service.close(guild, ticket.id);
      vi.mocked(discord.closeTicketThread).mockClear();
      vi.mocked(discord.grantReporterAccess).mockClear();
      vi.mocked(discord.reopenTicketThread).mockClear();
      vi.mocked(discord.restoreReporterAccess).mockClear();

      await expect(
        service.reopen(guild, ticket.id, {}, async () => {
          throw new Error("authorization revoked");
        }),
      ).rejects.toThrow("authorization revoked");
      await expect(store.get(ticket.id)).resolves.toMatchObject({
        status: "closed",
        triageStatus: "paused",
      });
      expect(discord.grantReporterAccess).not.toHaveBeenCalled();
      expect(discord.reopenTicketThread).not.toHaveBeenCalled();
      expect(discord.closeTicketThread).not.toHaveBeenCalled();
      expect(discord.restoreReporterAccess).not.toHaveBeenCalled();
      await expect(store.getReporterAccess(ticket)).resolves.toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("treats a concurrent reopen winner as harmless across service instances", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const realStore = createSqliteTicketStore(connection.database);
    let raceEnabled = false;
    let racers = 0;
    let releaseRace!: () => void;
    const raceGate = new Promise<void>((resolve) => {
      releaseRace = resolve;
    });
    const store = {
      ...realStore,
      reopen: async (...args: Parameters<typeof realStore.reopen>) => {
        if (raceEnabled) {
          racers += 1;
          if (racers === 2) releaseRace();
          await raceGate;
        }
        return realStore.reopen(...args);
      },
    };
    const discord = discordFixture();
    const firstService = createTicketProvisioningService(
      settings,
      store,
      discord,
      { createId: () => "ticket-concurrent-reopen" },
    );
    const secondService = createTicketProvisioningService(
      settings,
      store,
      discord,
    );
    try {
      const ticket = await firstService.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      await firstService.close(guild, ticket.id);
      vi.mocked(discord.closeTicketThread).mockClear();
      vi.mocked(discord.restoreReporterAccess).mockClear();
      raceEnabled = true;

      await expect(
        Promise.all([
          firstService.reopen(guild, ticket.id),
          secondService.reopen(guild, ticket.id),
        ]),
      ).resolves.toEqual([
        expect.objectContaining({ status: "open" }),
        expect.objectContaining({ status: "open" }),
      ]);
      expect(discord.closeTicketThread).not.toHaveBeenCalled();
      expect(discord.restoreReporterAccess).not.toHaveBeenCalled();
      await expect(realStore.get(ticket.id)).resolves.toMatchObject({
        status: "open",
        triageStatus: "paused",
      });
    } finally {
      connection.close();
    }
  });

  it("restores stale unshared ownership when a later reopen fails", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const realStore = createSqliteTicketStore(connection.database);
    let failFinish = false;
    const store = {
      ...realStore,
      finishReporterAccess: async (
        ticket: Parameters<typeof realStore.finishReporterAccess>[0],
      ) => {
        if (failFinish) throw new Error("ownership cleanup failed");
        return realStore.finishReporterAccess(ticket);
      },
    };
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => "ticket-stale-ownership",
    });
    try {
      const ticket = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      failFinish = true;
      await expect(service.close(guild, ticket.id)).rejects.toThrow(
        "ownership cleanup failed",
      );
      failFinish = false;
      vi.mocked(discord.restoreReporterAccess).mockClear();
      vi.mocked(discord.reopenTicketThread).mockRejectedValueOnce(
        new Error("cannot reopen thread"),
      );

      await expect(service.reopen(guild, ticket.id)).rejects.toThrow(
        "cannot reopen thread",
      );
      expect(discord.restoreReporterAccess).toHaveBeenCalledWith(
        guild,
        ticket.hubChannelId,
        ticket.reporterUserId,
        emptyAccessSnapshot,
      );
      await expect(
        realStore.getReporterAccess(ticket),
      ).resolves.toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("rejects reopening an already-open ticket before Discord side effects", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => "ticket-invalid-reopen",
    });
    try {
      const ticket = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      vi.mocked(discord.grantReporterAccess).mockClear();
      vi.mocked(discord.reopenTicketThread).mockClear();

      await expect(service.reopen(guild, ticket.id)).rejects.toBeInstanceOf(
        TicketStateTransitionError,
      );
      expect(discord.grantReporterAccess).not.toHaveBeenCalled();
      expect(discord.reopenTicketThread).not.toHaveBeenCalled();
    } finally {
      connection.close();
    }
  });

  it("rejects reopening a ticket after its configured support hub moved", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    let hubChannelId = "hub-1";
    const movingSettings = {
      get: async (guildId: string) => ({
        guildId,
        initialized: true,
        hubChannelId,
        assistantIdentity: "Prod",
        tone: "friendly",
      }),
    } as GuildSettingsStore;
    const discord = discordFixture();
    const service = createTicketProvisioningService(
      movingSettings,
      store,
      discord,
      { createId: () => "ticket-former-hub-reopen" },
    );
    try {
      const ticket = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      await service.close(guild, ticket.id);
      hubChannelId = "hub-2";
      vi.mocked(discord.grantReporterAccess).mockClear();

      await expect(service.reopen(guild, ticket.id)).rejects.toThrow(
        "former support hub",
      );
      expect(discord.grantReporterAccess).not.toHaveBeenCalled();
    } finally {
      connection.close();
    }
  });

  it("allows hub release only after dependent tickets stop being active", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const ticket = await store.create({
      id: "ticket-hub-release",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
    });
    const service = createTicketProvisioningService(
      settings,
      store,
      discordFixture(),
    );
    try {
      await expect(service.canReleaseHub(guild.id, "hub-1")).resolves.toBe(
        false,
      );
      await store.markFailed(ticket.id, "controlled failure");
      await expect(service.canReleaseHub(guild.id, "hub-1")).resolves.toBe(
        true,
      );
    } finally {
      connection.close();
    }
  });

  it("reads the configured hub only after an in-flight hub move completes", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const executeGuildOperation = createGuildOperationExecutor();
    let hubChannelId = "hub-old";
    const movingSettings = {
      get: async (guildId: string) => ({
        guildId,
        initialized: true,
        hubChannelId,
        assistantIdentity: "Prod",
        tone: "friendly",
      }),
    } as GuildSettingsStore;
    const discord = discordFixture();
    const service = createTicketProvisioningService(
      movingSettings,
      store,
      discord,
      {
        createId: () => "ticket-after-move",
        executeGuildOperation,
      },
    );
    let finishMove = (): void => undefined;
    let markMoveStarted = (): void => undefined;
    const moveStarted = new Promise<void>((resolve) => {
      markMoveStarted = resolve;
    });
    const moveGate = new Promise<void>((resolve) => {
      finishMove = resolve;
    });
    const move = executeGuildOperation(guild.id, async () => {
      markMoveStarted();
      await moveGate;
      hubChannelId = "hub-new";
    });
    await moveStarted;

    const opening = service.open({
      guild,
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
    });
    finishMove();
    await move;

    await expect(opening).resolves.toMatchObject({
      id: "ticket-after-move",
      hubChannelId: "hub-new",
      status: "open",
    });
    expect(discord.grantReporterAccess).toHaveBeenCalledWith(
      guild,
      "hub-new",
      reporter,
    );
    connection.close();
  });

  it("fails stale provisioning recovery without re-granting the former hub", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const ticket = await store.create({
      id: "ticket-former-hub",
      guildId: guild.id,
      hubChannelId: "hub-old",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
    });
    await store.beginReporterAccess(ticket, emptyAccessSnapshot);
    const replacementSettings = {
      get: async (guildId: string) => ({
        guildId,
        initialized: true,
        hubChannelId: "hub-new",
        assistantIdentity: "Prod",
        tone: "friendly",
      }),
    } as GuildSettingsStore;
    const discord = discordFixture();
    const service = createTicketProvisioningService(
      replacementSettings,
      store,
      discord,
    );
    try {
      await expect(service.recover(async () => guild)).resolves.toEqual({
        recovered: 0,
        failed: 1,
      });

      expect(discord.grantReporterAccess).not.toHaveBeenCalled();
      expect(discord.createTicketThread).not.toHaveBeenCalled();
      expect(discord.restoreReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-old",
        "reporter-1",
        emptyAccessSnapshot,
      );
      expect(await store.get(ticket.id)).toMatchObject({
        status: "failed",
        failureReason:
          "The configured support hub changed before ticket recovery",
      });
    } finally {
      connection.close();
    }
  });

  it("reasserts suspension when former-hub resumption waits behind a move", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const ticket = await store.create({
      id: "ticket-resume-former-hub",
      guildId: guild.id,
      hubChannelId: "hub-old",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
    });
    await store.beginReporterAccess(ticket, emptyAccessSnapshot);
    const executeGuildOperation = createGuildOperationExecutor();
    let hubChannelId = "hub-old";
    const movingSettings = {
      get: async (guildId: string) => ({
        guildId,
        initialized: true,
        hubChannelId,
        assistantIdentity: "Prod",
        tone: "friendly",
      }),
    } as GuildSettingsStore;
    const discord = discordFixture();
    const service = createTicketProvisioningService(
      movingSettings,
      store,
      discord,
      { executeGuildOperation },
    );
    let finishMove = (): void => undefined;
    let markMoveStarted = (): void => undefined;
    const moveStarted = new Promise<void>((resolve) => {
      markMoveStarted = resolve;
    });
    const moveGate = new Promise<void>((resolve) => {
      finishMove = resolve;
    });
    const move = executeGuildOperation(guild.id, async () => {
      markMoveStarted();
      await moveGate;
      hubChannelId = "hub-new";
    });
    await moveStarted;

    const resumption = service.resumeHubAccess(guild, "hub-old");
    finishMove();
    await move;
    try {
      await expect(resumption).resolves.toBe(1);
      expect(discord.grantReporterAccess).not.toHaveBeenCalled();
      expect(discord.restoreReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-old",
        "reporter-1",
        emptyAccessSnapshot,
      );
      expect(await store.getReporterAccess(ticket)).toEqual(
        emptyAccessSnapshot,
      );
    } finally {
      connection.close();
    }
  });

  it("requires support-hub setup before reserving a ticket", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture();
    const unconfiguredSettings = {
      get: async (guildId: string) => ({
        guildId,
        initialized: false,
        assistantIdentity: "Prod",
        tone: "friendly",
      }),
    } as GuildSettingsStore;
    const service = createTicketProvisioningService(
      unconfiguredSettings,
      store,
      discord,
    );
    try {
      await expect(
        service.open({
          guild,
          reporterUserId: "reporter-1",
          originatingAlias: "issue",
        }),
      ).rejects.toBeInstanceOf(TicketSetupRequiredError);
      expect(discord.validateReporter).not.toHaveBeenCalled();
      expect(await store.listProvisioning()).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("sanitizes the summary and opens only after every Discord resource succeeds", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => "ticket-12345678",
    });
    try {
      const ticket = await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
        summary: "  **Crash**\u202e @everyone\nwhen clicking  ",
      });

      expect(ticket).toMatchObject({
        status: "open",
        threadId: "thread-1",
        openingMessageId: "message-1",
        summary: "\\*\\*Crash\\*\\* @\u200beveryone when clicking",
      });
      expect(discord.grantReporterAccess).toHaveBeenCalledBefore(
        vi.mocked(discord.createTicketThread),
      );
      expect(discord.findTicketThread).not.toHaveBeenCalled();
      expect(discord.addReporter).toHaveBeenCalledWith(
        guild,
        "thread-1",
        "reporter-1",
      );
      expect(ticketOpeningInstructions(ticket)).toContain("`DEBUGSHARE`");
      expect(ticketOpeningInstructions(ticket)).toContain("ticket:1");
      expect(
        (await store.listEvents(ticket.id)).map(({ eventType }) => eventType),
      ).toEqual([
        "provisioning_started",
        "reporter_access_granted",
        "thread_created",
        "reporter_added",
        "instructions_posted",
        "opened",
      ]);
    } finally {
      connection.close();
    }
  });

  it("compensates a partial failure without removing access needed by another ticket", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    let ticketNumber = 0;
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => `ticket-${++ticketNumber}`,
    });
    try {
      await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      vi.mocked(discord.createTicketThread).mockResolvedValueOnce("thread-2");
      vi.mocked(discord.addReporter).mockRejectedValueOnce(
        new Error("controlled Discord failure"),
      );

      await expect(
        service.open({
          guild,
          reporterUserId: "reporter-1",
          originatingAlias: "report",
        }),
      ).rejects.toMatchObject({ name: "TicketProvisioningError" });

      expect(discord.deleteTicketThread).toHaveBeenCalledWith(
        guild,
        "thread-2",
      );
      expect(discord.restoreReporterAccess).not.toHaveBeenCalled();
      const failed = await store.get("ticket-2");
      expect(failed).toMatchObject({
        status: "failed",
        failureReason: "controlled Discord failure",
      });
      expect((await store.listEvents("ticket-2")).at(-1)?.eventType).toBe(
        "compensation_completed",
      );
    } finally {
      connection.close();
    }
  });

  it("compensates Discord access when the following database audit write fails", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture();
    const failingStore = {
      ...store,
      recordProgress: vi
        .fn(store.recordProgress)
        .mockRejectedValueOnce(new Error("controlled database failure")),
    };
    const service = createTicketProvisioningService(
      settings,
      failingStore,
      discord,
      { createId: () => "ticket-db-failure" },
    );
    try {
      await expect(
        service.open({
          guild,
          reporterUserId: "reporter-1",
          originatingAlias: "issue",
        }),
      ).rejects.toMatchObject({ name: "TicketProvisioningError" });

      expect(discord.grantReporterAccess).toHaveBeenCalledOnce();
      expect(discord.createTicketThread).not.toHaveBeenCalled();
      expect(discord.validateReporter).toHaveBeenCalledBefore(
        vi.mocked(discord.grantReporterAccess),
      );
      expect(discord.restoreReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-1",
        "reporter-1",
        emptyAccessSnapshot,
      );
      expect(await store.get("ticket-db-failure")).toMatchObject({
        status: "failed",
        failureReason: "controlled database failure",
      });
      expect(
        (await store.listEvents("ticket-db-failure")).map(
          ({ eventType }) => eventType,
        ),
      ).toEqual([
        "provisioning_started",
        "provisioning_failed",
        "compensation_completed",
      ]);
    } finally {
      connection.close();
    }
  });

  it("audits a transient thread cleanup error as failed compensation", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture({
      addReporter: vi.fn().mockRejectedValue(new Error("member add failed")),
      deleteTicketThread: vi
        .fn()
        .mockRejectedValue(new Error("Discord temporarily unavailable")),
    });
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => "ticket-cleanup-failure",
    });
    try {
      await expect(
        service.open({
          guild,
          reporterUserId: "reporter-1",
          originatingAlias: "issue",
        }),
      ).rejects.toMatchObject({ name: "TicketProvisioningError" });
      expect(
        (await store.listEvents("ticket-cleanup-failure")).at(-1)?.eventType,
      ).toBe("compensation_failed");
    } finally {
      connection.close();
    }
  });

  it("retries orphaned reporter access after failed compensation", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture({
      restoreReporterAccess: vi
        .fn()
        .mockRejectedValueOnce(new Error("restore unavailable one"))
        .mockRejectedValueOnce(new Error("restore unavailable two"))
        .mockRejectedValueOnce(new Error("restore unavailable three"))
        .mockResolvedValueOnce(undefined),
    });
    const failingStore = {
      ...store,
      recordProgress: vi
        .fn(store.recordProgress)
        .mockRejectedValueOnce(new Error("controlled database failure")),
    };
    const service = createTicketProvisioningService(
      settings,
      failingStore,
      discord,
      { createId: () => "ticket-orphaned-access" },
    );
    try {
      await expect(
        service.open({
          guild,
          reporterUserId: "reporter-1",
          originatingAlias: "issue",
        }),
      ).rejects.toMatchObject({ name: "TicketProvisioningError" });
      expect(discord.restoreReporterAccess).toHaveBeenCalledTimes(3);
      const failed = (await store.get("ticket-orphaned-access"))!;
      expect(failed.status).toBe("failed");
      await expect(store.getReporterAccess(failed)).resolves.toEqual(
        emptyAccessSnapshot,
      );

      await expect(service.resumeHubAccess(guild, "hub-1")).resolves.toBe(0);
      expect(discord.restoreReporterAccess).toHaveBeenCalledTimes(4);
      await expect(store.getReporterAccess(failed)).resolves.toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("fails an admitted ticket before access ownership without restoring unknown state", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const discord = discordFixture({
      validateReporter: vi
        .fn()
        .mockRejectedValue(new Error("reporter left the guild")),
    });
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => "ticket-invalid-reporter",
    });
    try {
      await expect(
        service.open({
          guild,
          reporterUserId: "reporter-1",
          originatingAlias: "issue",
        }),
      ).rejects.toMatchObject({ name: "TicketProvisioningError" });

      expect(discord.captureReporterAccess).not.toHaveBeenCalled();
      expect(discord.restoreReporterAccess).not.toHaveBeenCalled();
      expect(await store.get("ticket-invalid-reporter")).toMatchObject({
        status: "failed",
        failureReason: "reporter left the guild",
      });
      expect(
        (await store.listEvents("ticket-invalid-reporter")).at(-1)?.eventType,
      ).toBe("compensation_completed");
    } finally {
      connection.close();
    }
  });

  it("restores persisted access when recovery fails before this run begins ownership", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const ticket = await store.create({
      id: "ticket-stale-access",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
    });
    await store.beginReporterAccess(ticket, emptyAccessSnapshot);
    const discord = discordFixture({
      validateReporter: vi
        .fn()
        .mockRejectedValue(new Error("reporter lookup unavailable")),
    });
    const service = createTicketProvisioningService(settings, store, discord);
    try {
      await expect(service.recover(async () => guild)).resolves.toEqual({
        recovered: 0,
        failed: 1,
      });

      expect(discord.restoreReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-1",
        "reporter-1",
        emptyAccessSnapshot,
      );
      expect(await store.getReporterAccess(ticket)).toBeUndefined();
      expect(await store.get(ticket.id)).toMatchObject({ status: "failed" });
    } finally {
      connection.close();
    }
  });

  it("reconciles numbered presentation for tickets opened before the upgrade", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const ticket = await store.create({
      id: "ticket-legacy-open",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
    });
    await store.recordProgress(
      ticket.id,
      "thread_created",
      {},
      { threadId: "thread-legacy" },
    );
    await store.recordProgress(
      ticket.id,
      "instructions_posted",
      {},
      { openingMessageId: "message-legacy" },
    );
    await store.markOpen(ticket.id);
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord);

    try {
      await expect(service.recover(async () => guild)).resolves.toEqual({
        recovered: 0,
        failed: 0,
      });
      expect(discord.reconcileTicketPresentation).toHaveBeenCalledWith(
        guild,
        expect.objectContaining({ id: ticket.id, number: 1 }),
      );
    } finally {
      connection.close();
    }
  });

  it("suspends and resumes every persisted reporter access ownership", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const first = await store.create({
      id: "ticket-access-one",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
    });
    const second = await store.create({
      id: "ticket-access-two",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-2",
      originatingAlias: "report",
    });
    const existingAccessSnapshot: ReporterHubAccessSnapshot = {
      ...emptyAccessSnapshot,
      overwriteExisted: true,
      permissions: {
        ...emptyAccessSnapshot.permissions,
        ViewChannel: "allow",
      },
    };
    await store.beginReporterAccess(first, emptyAccessSnapshot);
    await store.beginReporterAccess(second, existingAccessSnapshot);
    const reporters = new Map([
      ["reporter-1", { id: "reporter-1" } as GuildMember],
      ["reporter-2", { id: "reporter-2" } as GuildMember],
    ]);
    const discord = discordFixture({
      validateReporter: vi.fn(async (_guild, reporterUserId) =>
        Promise.resolve(reporters.get(reporterUserId)!),
      ),
      restoreReporterAccess: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("transient restore failure one"))
        .mockRejectedValueOnce(new Error("transient restore failure two"))
        .mockResolvedValueOnce(undefined),
    });
    const service = createTicketProvisioningService(settings, store, discord);
    try {
      await expect(service.suspendHubAccess(guild, "hub-1")).resolves.toBe(2);
      expect(discord.restoreReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-1",
        "reporter-1",
        emptyAccessSnapshot,
      );
      expect(discord.restoreReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-1",
        "reporter-2",
        existingAccessSnapshot,
      );
      expect(discord.restoreReporterAccess).toHaveBeenCalledTimes(4);
      expect(await store.getReporterAccess(first)).toEqual(emptyAccessSnapshot);
      expect(await store.getReporterAccess(second)).toEqual(
        existingAccessSnapshot,
      );

      await expect(service.resumeHubAccess(guild, "hub-1")).resolves.toBe(2);
      expect(discord.grantReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-1",
        reporters.get("reporter-1"),
      );
      expect(discord.grantReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-1",
        reporters.get("reporter-2"),
      );
    } finally {
      connection.close();
    }
  });

  it("restores retained ownership for a failed ticket during resumption", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const failed = await store.create({
      id: "ticket-failed-access",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-failed",
      originatingAlias: "issue",
    });
    await store.beginReporterAccess(failed, emptyAccessSnapshot);
    await store.markFailed(failed.id, "restore remained unavailable");
    const discord = discordFixture();
    const service = createTicketProvisioningService(settings, store, discord);
    try {
      await expect(service.resumeHubAccess(guild, "hub-1")).resolves.toBe(0);
      expect(discord.validateReporter).not.toHaveBeenCalled();
      expect(discord.grantReporterAccess).not.toHaveBeenCalled();
      expect(discord.restoreReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-1",
        "reporter-failed",
        emptyAccessSnapshot,
      );
      await expect(store.getReporterAccess(failed)).resolves.toBeUndefined();
      await expect(service.suspendHubAccess(guild, "hub-1")).resolves.toBe(0);
    } finally {
      connection.close();
    }
  });

  it("skips departed reporters while resuming remaining active access", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const departed = await store.create({
      id: "ticket-departed-reporter",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-departed",
      originatingAlias: "issue",
    });
    const remaining = await store.create({
      id: "ticket-remaining-reporter",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-remaining",
      originatingAlias: "report",
    });
    await store.beginReporterAccess(departed, emptyAccessSnapshot);
    await store.beginReporterAccess(remaining, emptyAccessSnapshot);
    const remainingReporter = { id: "reporter-remaining" } as GuildMember;
    const discord = discordFixture({
      validateReporter: vi.fn(async (_guild, reporterUserId) => {
        if (reporterUserId === "reporter-departed") {
          throw { code: RESTJSONErrorCodes.UnknownMember };
        }
        return remainingReporter;
      }),
    });
    const service = createTicketProvisioningService(settings, store, discord);
    try {
      await expect(service.resumeHubAccess(guild, "hub-1")).resolves.toBe(1);
      expect(discord.validateReporter).toHaveBeenCalledTimes(2);
      expect(discord.grantReporterAccess).toHaveBeenCalledOnce();
      expect(discord.grantReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-1",
        remainingReporter,
      );
    } finally {
      connection.close();
    }
  });

  it("recovers a known thread idempotently without creating another thread", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const ticket = await store.create({
      id: "ticket-stale",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "debugshare",
    });
    await store.recordProgress(
      ticket.id,
      "thread_created",
      {},
      { threadId: "thread-existing" },
    );
    const discord = discordFixture({
      upsertOpeningInstructions: vi.fn().mockResolvedValue({
        messageId: "message-existing",
        created: false,
        previousContent: "existing instructions",
      }),
    });
    const service = createTicketProvisioningService(settings, store, discord);
    try {
      await expect(service.recover(async () => guild)).resolves.toEqual({
        recovered: 1,
        failed: 0,
      });
      await expect(service.recover(async () => guild)).resolves.toEqual({
        recovered: 0,
        failed: 0,
      });
      expect(discord.createTicketThread).not.toHaveBeenCalled();
      expect(discord.validateReporter).toHaveBeenCalledBefore(
        vi.mocked(discord.grantReporterAccess),
      );
      expect(discord.prepareTicketThread).toHaveBeenCalledWith(
        guild,
        "thread-existing",
        expect.objectContaining({ id: ticket.id }),
      );
      expect(discord.addReporter).toHaveBeenCalledOnce();
      expect(discord.upsertOpeningInstructions).toHaveBeenCalledOnce();
      expect(await store.get(ticket.id)).toMatchObject({
        status: "open",
        threadId: "thread-existing",
        openingMessageId: "message-existing",
      });
    } finally {
      connection.close();
    }
  });

  it("discovers and owns a legacy-named thread before restoring reporter access", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const ticket = await store.create({
      id: "ticket-legacy-orphan",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
    });
    const findTicketThread = vi.fn().mockResolvedValue("thread-legacy");
    const grantReporterAccess = vi.fn().mockResolvedValue(undefined);
    const discord = discordFixture({
      findTicketThread,
      grantReporterAccess,
    });
    const service = createTicketProvisioningService(settings, store, discord);

    try {
      await expect(
        service.discoverRecoveryThreads(async () => guild),
      ).resolves.toEqual({ discovered: 1, failed: 0 });
      await expect(service.recover(async () => guild)).resolves.toEqual({
        recovered: 1,
        failed: 0,
      });
      expect(findTicketThread).toHaveBeenCalledBefore(grantReporterAccess);
      expect(discord.createTicketThread).not.toHaveBeenCalled();
      expect(await store.get(ticket.id)).toMatchObject({
        status: "open",
        threadId: "thread-legacy",
      });
    } finally {
      connection.close();
    }
  });

  it("preserves a pre-existing recovery thread when replay still fails", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const ticket = await store.create({
      id: "ticket-preserved",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
    });
    await store.recordProgress(
      ticket.id,
      "thread_created",
      {},
      { threadId: "thread-existing" },
    );
    const discord = discordFixture({
      addReporter: vi.fn().mockRejectedValue(new Error("Discord unavailable")),
    });
    const service = createTicketProvisioningService(settings, store, discord);
    try {
      await expect(service.recover(async () => guild)).resolves.toEqual({
        recovered: 0,
        failed: 1,
      });
      expect(discord.deleteTicketThread).not.toHaveBeenCalled();
      expect(discord.rollbackTicketThread).toHaveBeenCalledWith(
        guild,
        "thread-existing",
        expect.objectContaining({ id: ticket.id }),
        { wasArchived: false, reporterWasMember: false },
        undefined,
      );
      expect(await store.get(ticket.id)).toMatchObject({ status: "failed" });
    } finally {
      connection.close();
    }
  });

  it("rolls back owned mutations when finalizing a recovered thread fails", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database);
    const ticket = await store.create({
      id: "ticket-recovery-rollback",
      guildId: guild.id,
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
    });
    await store.recordProgress(
      ticket.id,
      "thread_created",
      {},
      { threadId: "thread-existing" },
    );
    const opening = {
      messageId: "message-existing",
      created: false,
      previousContent: "previous instructions",
    } as const;
    const discord = discordFixture({
      prepareTicketThread: vi.fn().mockResolvedValue({
        wasArchived: true,
        reporterWasMember: false,
      }),
      upsertOpeningInstructions: vi.fn().mockResolvedValue(opening),
    });
    const failingStore = {
      ...store,
      markOpen: vi.fn().mockRejectedValue(new Error("database unavailable")),
    };
    const service = createTicketProvisioningService(
      settings,
      failingStore,
      discord,
    );
    try {
      await expect(service.recover(async () => guild)).resolves.toEqual({
        recovered: 0,
        failed: 1,
      });
      expect(discord.rollbackTicketThread).toHaveBeenCalledWith(
        guild,
        "thread-existing",
        expect.objectContaining({ id: ticket.id }),
        { wasArchived: true, reporterWasMember: false },
        opening,
      );
      expect(await store.get(ticket.id)).toMatchObject({ status: "failed" });
    } finally {
      connection.close();
    }
  });

  it("releases failed provisioning access when active tickets belong to another hub", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database, {
      maxTicketsPerReporterWindow: 10,
    });
    const old = await store.create({
      id: "ticket-old-hub",
      guildId: guild.id,
      hubChannelId: "hub-old",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
    });
    await store.recordProgress(
      old.id,
      "thread_created",
      {},
      { threadId: "thread-old" },
    );
    await store.recordProgress(
      old.id,
      "instructions_posted",
      {},
      { openingMessageId: "message-old" },
    );
    await store.markOpen(old.id);
    const newHubSettings = {
      ...settings,
      get: async (guildId: string) => ({
        guildId,
        initialized: true,
        hubChannelId: "hub-new",
        assistantIdentity: "Prod",
        tone: "friendly",
      }),
    } as GuildSettingsStore;
    const discord = discordFixture({
      addReporter: vi.fn().mockRejectedValue(new Error("controlled failure")),
    });
    const service = createTicketProvisioningService(
      newHubSettings,
      store,
      discord,
      { createId: () => "ticket-new-hub" },
    );
    try {
      await expect(
        service.open({
          guild,
          reporterUserId: "reporter-1",
          originatingAlias: "issue",
        }),
      ).rejects.toMatchObject({ name: "TicketProvisioningError" });
      expect(discord.restoreReporterAccess).toHaveBeenCalledWith(
        guild,
        "hub-new",
        "reporter-1",
        emptyAccessSnapshot,
      );
    } finally {
      connection.close();
    }
  });

  it("rejects an admitted burst before creating additional Discord resources", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const store = createSqliteTicketStore(connection.database, {
      maxTicketsPerReporterWindow: 1,
    });
    const discord = discordFixture();
    let id = 0;
    const service = createTicketProvisioningService(settings, store, discord, {
      createId: () => `ticket-${++id}`,
    });
    try {
      await service.open({
        guild,
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
      });
      await expect(
        service.open({
          guild,
          reporterUserId: "reporter-1",
          originatingAlias: "issue",
        }),
      ).rejects.toMatchObject({
        name: "TicketAdmissionError",
        code: "rate_limited",
      });
      expect(discord.grantReporterAccess).toHaveBeenCalledOnce();
      expect(discord.createTicketThread).toHaveBeenCalledOnce();
      expect(discord.validateReporter).toHaveBeenCalledOnce();
      expect(discord.captureReporterAccess).toHaveBeenCalledOnce();
      expect(await store.get("ticket-2")).toBeUndefined();
    } finally {
      connection.close();
    }
  });
});

describe("Discord ticket privacy adapter", () => {
  it("verifies that the reporter still belongs to the guild", async () => {
    const fetch = vi.fn().mockResolvedValue({ id: "reporter-1" });
    const mockGuild = { members: { fetch } } as unknown as Guild;

    await createTicketProvisioningDiscord().validateReporter(
      mockGuild,
      "reporter-1",
    );

    expect(fetch).toHaveBeenCalledWith("reporter-1");
  });

  it("grants only shared hub/thread capabilities and posts no hub content", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn();
    const mockGuild = {
      roles: { everyone: { id: "everyone" }, cache: new Collection() },
      members: { me: { id: "bot-1" }, fetchMe: vi.fn() },
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.GuildText,
          permissionOverwrites: {
            edit,
            cache: new Collection([
              [
                "everyone",
                {
                  id: "everyone",
                  deny: new PermissionsBitField(
                    PermissionFlagsBits.ManageThreads,
                  ),
                },
              ],
            ]),
          },
          threads: {
            fetchActive: vi.fn().mockResolvedValue({
              threads: new Collection([
                [
                  "managed-private",
                  {
                    id: "managed-private",
                    type: ChannelType.PrivateThread,
                  },
                ],
              ]),
            }),
            fetchArchived: vi.fn().mockResolvedValue({
              threads: new Collection(),
              hasMore: false,
            }),
          },
          messages: {
            fetch: vi.fn().mockResolvedValue(new Collection()),
          },
          send,
        }),
      },
    } as unknown as Guild;

    await createTicketProvisioningDiscord().grantReporterAccess(
      mockGuild,
      "hub-1",
      reporter,
    );

    expect(edit).toHaveBeenCalledWith(
      reporter,
      REPORTER_TICKET_HUB_OVERWRITE,
      expect.objectContaining({
        type: OverwriteType.Member,
        reason: expect.any(String),
      }),
    );
    expect(REPORTER_TICKET_HUB_OVERWRITE).toEqual({
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessagesInThreads: true,
      UseApplicationCommands: true,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      ManageThreads: false,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not police moderator-managed hub overwrites", async () => {
    const edit = vi.fn();
    const mockGuild = {
      roles: {
        everyone: { id: "everyone" },
        cache: new Collection([["role-1", { id: "role-1" }]]),
      },
      members: { me: { id: "bot-1" }, fetchMe: vi.fn() },
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.GuildText,
          permissionOverwrites: {
            edit,
            cache: new Collection([
              [
                "everyone",
                {
                  id: "everyone",
                  deny: new PermissionsBitField(
                    PermissionFlagsBits.ManageThreads,
                  ),
                },
              ],
              [
                "role-1",
                {
                  id: "role-1",
                  type: OverwriteType.Role,
                  allow: new PermissionsBitField(
                    PermissionFlagsBits.SendMessages,
                  ),
                },
              ],
            ]),
          },
          threads: {
            fetchActive: vi.fn().mockResolvedValue({
              threads: new Collection(),
            }),
            fetchArchived: vi.fn().mockResolvedValue({
              threads: new Collection(),
              hasMore: false,
            }),
          },
          messages: {
            fetch: vi.fn().mockResolvedValue(new Collection()),
          },
        }),
      },
    } as unknown as Guild;

    await expect(
      createTicketProvisioningDiscord().grantReporterAccess(
        mockGuild,
        "hub-1",
        reporter,
      ),
    ).resolves.toBeUndefined();
    expect(edit).toHaveBeenCalledOnce();
  });

  it("does not police moderator-created public threads", async () => {
    const edit = vi.fn();
    const mockGuild = {
      roles: { everyone: { id: "everyone" }, cache: new Collection() },
      members: { me: { id: "bot-1" }, fetchMe: vi.fn() },
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.GuildText,
          permissionOverwrites: {
            edit,
            cache: new Collection([
              [
                "everyone",
                {
                  id: "everyone",
                  deny: new PermissionsBitField(
                    PermissionFlagsBits.ManageThreads,
                  ),
                },
              ],
            ]),
          },
          threads: {
            fetchActive: vi.fn().mockResolvedValue({
              threads: new Collection([
                [
                  "public-1",
                  { id: "public-1", type: ChannelType.PublicThread },
                ],
              ]),
            }),
            fetchArchived: vi.fn().mockResolvedValue({
              threads: new Collection(),
              hasMore: false,
            }),
          },
          messages: {
            fetch: vi.fn().mockResolvedValue(new Collection()),
          },
        }),
      },
    } as unknown as Guild;

    await expect(
      createTicketProvisioningDiscord().grantReporterAccess(
        mockGuild,
        "hub-1",
        reporter,
      ),
    ).resolves.toBeUndefined();
    expect(edit).toHaveBeenCalledOnce();
  });

  it("does not police moderator-created private threads", async () => {
    const edit = vi.fn();
    const mockGuild = {
      roles: { everyone: { id: "everyone" }, cache: new Collection() },
      members: { me: { id: "bot-1" }, fetchMe: vi.fn() },
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.GuildText,
          permissionOverwrites: {
            edit,
            cache: new Collection([
              [
                "everyone",
                {
                  id: "everyone",
                  deny: new PermissionsBitField(
                    PermissionFlagsBits.ManageThreads,
                  ),
                },
              ],
            ]),
          },
          threads: {
            fetchActive: vi.fn().mockResolvedValue({
              threads: new Collection([
                [
                  "unmanaged-private",
                  {
                    id: "unmanaged-private",
                    type: ChannelType.PrivateThread,
                  },
                ],
              ]),
            }),
            fetchArchived: vi.fn().mockResolvedValue({
              threads: new Collection(),
              hasMore: false,
            }),
          },
          messages: {
            fetch: vi.fn().mockResolvedValue(new Collection()),
          },
        }),
      },
    } as unknown as Guild;

    await expect(
      createTicketProvisioningDiscord().grantReporterAccess(
        mockGuild,
        "hub-1",
        reporter,
      ),
    ).resolves.toBeUndefined();
    expect(edit).toHaveBeenCalledOnce();
  });

  it("does not police moderator-managed hub history", async () => {
    const edit = vi.fn();
    const mockGuild = {
      roles: { everyone: { id: "everyone" }, cache: new Collection() },
      members: { me: { id: "bot-1" }, fetchMe: vi.fn() },
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.GuildText,
          permissionOverwrites: {
            edit,
            cache: new Collection([
              [
                "everyone",
                {
                  id: "everyone",
                  deny: new PermissionsBitField(
                    PermissionFlagsBits.ManageThreads,
                  ),
                },
              ],
            ]),
          },
          threads: {
            fetchActive: vi.fn().mockResolvedValue({
              threads: new Collection(),
            }),
            fetchArchived: vi.fn().mockResolvedValue({
              threads: new Collection(),
              hasMore: false,
            }),
          },
          messages: {
            fetch: vi.fn().mockResolvedValue(
              new Collection([
                [
                  "history-1",
                  {
                    id: "history-1",
                    author: { id: "staff-1" },
                    content: "Prior support details",
                  },
                ],
              ]),
            ),
          },
        }),
      },
    } as unknown as Guild;

    await expect(
      createTicketProvisioningDiscord().grantReporterAccess(
        mockGuild,
        "hub-1",
        reporter,
      ),
    ).resolves.toBeUndefined();
    expect(edit).toHaveBeenCalledOnce();
  });

  it("ignores only a missing thread during cleanup", async () => {
    const adapter = createTicketProvisioningDiscord();
    const missingGuild = {
      channels: {
        fetch: vi
          .fn()
          .mockRejectedValue({ code: RESTJSONErrorCodes.UnknownChannel }),
      },
    } as unknown as Guild;
    await expect(
      adapter.deleteTicketThread(missingGuild, "thread-missing"),
    ).resolves.toBeUndefined();

    const transient = new Error("Discord temporarily unavailable");
    const unavailableGuild = {
      channels: { fetch: vi.fn().mockRejectedValue(transient) },
    } as unknown as Guild;
    await expect(
      adapter.deleteTicketThread(unavailableGuild, "thread-unknown"),
    ).rejects.toBe(transient);
  });

  it("restores owned permission fields without erasing moderation state", async () => {
    const reporterId = "reporter-1";
    const overwrite = {
      id: reporterId,
      allow: new PermissionsBitField(),
      deny: new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels,
      ]),
    };
    const cache = new Collection([[reporterId, overwrite]]);
    const edit = vi.fn(
      async (
        _target: unknown,
        patch: Readonly<Record<string, boolean | null>>,
      ) => {
        for (const [name, value] of Object.entries(patch)) {
          const bit =
            PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
          overwrite.allow.remove(bit);
          overwrite.deny.remove(bit);
          if (value === true) overwrite.allow.add(bit);
          if (value === false) overwrite.deny.add(bit);
        }
      },
    );
    const remove = vi.fn().mockResolvedValue(undefined);
    const hub = {
      type: ChannelType.GuildText,
      permissionOverwrites: { cache, edit, delete: remove },
    };
    const mockGuild = {
      channels: { fetch: vi.fn().mockResolvedValue(hub) },
    } as unknown as Guild;
    const adapter = createTicketProvisioningDiscord();
    const snapshot = await adapter.captureReporterAccess(
      mockGuild,
      "hub-1",
      reporterId,
    );
    overwrite.allow = new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.UseApplicationCommands,
    ]);
    overwrite.deny = new PermissionsBitField([
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.CreatePrivateThreads,
      PermissionFlagsBits.ManageChannels,
    ]);

    await adapter.restoreReporterAccess(
      mockGuild,
      "hub-1",
      reporterId,
      snapshot,
    );

    expect(overwrite.deny.has(PermissionFlagsBits.ViewChannel)).toBe(true);
    expect(overwrite.deny.has(PermissionFlagsBits.ManageChannels)).toBe(true);
    expect(overwrite.allow.has(PermissionFlagsBits.SendMessagesInThreads)).toBe(
      false,
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it("paginates archived discovery and reactivates the matched thread", async () => {
    const oldest = {
      id: "thread-oldest",
      name: "another-ticket",
      type: ChannelType.PrivateThread,
    };
    const match = {
      id: "thread-match",
      name: "ticket-ticketst",
      ownerId: "bot-1",
      type: ChannelType.PrivateThread,
    };
    const fetchArchived = vi
      .fn()
      .mockResolvedValueOnce({
        threads: new Collection([[oldest.id, oldest]]),
        hasMore: true,
      })
      .mockResolvedValueOnce({
        threads: new Collection([[match.id, match]]),
        hasMore: false,
      });
    const hub = {
      type: ChannelType.GuildText,
      threads: {
        fetchActive: vi.fn().mockResolvedValue({
          threads: new Collection([
            [
              "thread-impostor",
              {
                id: "thread-impostor",
                name: "ticket-ticketst",
                ownerId: "staff-1",
                type: ChannelType.PrivateThread,
              },
            ],
          ]),
        }),
        fetchArchived,
      },
    };
    const setArchived = vi.fn().mockResolvedValue(undefined);
    const getThreadMember = vi
      .fn()
      .mockRejectedValue({ code: RESTJSONErrorCodes.UnknownMember });
    const thread = {
      id: "thread-match",
      type: ChannelType.PrivateThread,
      parentId: "hub-1",
      archived: true,
      setArchived,
      client: { rest: { get: getThreadMember } },
    };
    const fetch = vi.fn(async (id: string) => (id === "hub-1" ? hub : thread));
    const mockGuild = {
      channels: { fetch },
      members: { me: { id: "bot-1" } },
    } as unknown as Guild;
    const adapter = createTicketProvisioningDiscord();
    const ticket = {
      id: "ticket-stale",
      number: 1,
      guildId: "guild-1",
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
      status: "provisioning",
      triageStatus: "collecting",
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:00:00.000Z",
    } as const;

    await expect(adapter.findTicketThread(mockGuild, ticket)).resolves.toBe(
      "thread-match",
    );
    expect(fetchArchived).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: oldest, fetchAll: true }),
    );
    await expect(
      adapter.prepareTicketThread(mockGuild, "thread-match", ticket),
    ).resolves.toEqual({ wasArchived: true, reporterWasMember: false });
    expect(setArchived).toHaveBeenCalledWith(false, "Recover Prod ticket 1");
    expect(getThreadMember).toHaveBeenCalledWith(
      Routes.threadMembers("thread-match", "reporter-1"),
    );
  });

  it("creates an invite-only private thread without a hub starter message", async () => {
    const create = vi.fn().mockResolvedValue({ id: "thread-1" });
    const send = vi.fn();
    const mockGuild = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.GuildText,
          threads: { create },
          send,
        }),
      },
    } as unknown as Guild;

    await createTicketProvisioningDiscord().createTicketThread(mockGuild, {
      id: "12345678-abcd",
      number: 42,
      guildId: "guild-1",
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
      status: "provisioning",
      triageStatus: "collecting",
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:00:00.000Z",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ticket-42",
        type: ChannelType.PrivateThread,
        invitable: false,
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("locks then archives on close and unarchives then unlocks on reopen", async () => {
    const calls: string[] = [];
    const thread = {
      type: ChannelType.PrivateThread,
      parentId: "hub-1",
      locked: false,
      archived: false,
      setLocked: vi.fn(async (locked: boolean) => {
        calls.push(`locked:${String(locked)}`);
        thread.locked = locked;
      }),
      setArchived: vi.fn(async (archived: boolean) => {
        calls.push(`archived:${String(archived)}`);
        thread.archived = archived;
      }),
    };
    const mockGuild = {
      channels: { fetch: vi.fn().mockResolvedValue(thread) },
    } as unknown as Guild;
    const ticket = {
      id: "ticket-lifecycle-adapter",
      number: 42,
      guildId: "guild-1",
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
      status: "closed",
      triageStatus: "paused",
      threadId: "thread-1",
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:00:00.000Z",
    } as const;
    const adapter = createTicketProvisioningDiscord();

    await adapter.closeTicketThread(mockGuild, ticket);
    await adapter.reopenTicketThread(mockGuild, ticket);

    expect(calls).toEqual([
      "locked:true",
      "archived:true",
      "archived:false",
      "locked:false",
    ]);
  });

  it("edits deterministic instructions found by marker instead of duplicating them", async () => {
    const edit = vi.fn().mockResolvedValue({ id: "message-existing" });
    const editCollision = vi.fn();
    const send = vi.fn();
    const messages = new Collection([
      [
        "message-reporter",
        {
          id: "message-reporter",
          content: "copied marker ticket:42",
          author: { id: "reporter-1" },
          editable: false,
        },
      ],
      [
        "message-collision",
        {
          id: "message-collision",
          content: "-# Managed by Prod · ticket:420",
          author: { id: "bot-1" },
          editable: true,
          edit: editCollision,
        },
      ],
      [
        "message-existing",
        {
          id: "message-existing",
          content: "-# Managed by Prod · ticket:ticket-stale",
          author: { id: "bot-1" },
          editable: true,
          edit,
        },
      ],
    ]);
    const mockGuild = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.PrivateThread,
          client: { user: { id: "bot-1" } },
          messages: { fetch: vi.fn().mockResolvedValue(messages) },
          send,
        }),
      },
    } as unknown as Guild;

    await expect(
      createTicketProvisioningDiscord().upsertOpeningInstructions(mockGuild, {
        id: "ticket-stale",
        number: 42,
        guildId: "guild-1",
        hubChannelId: "hub-1",
        reporterUserId: "reporter-1",
        originatingAlias: "issue",
        status: "provisioning",
        triageStatus: "collecting",
        threadId: "thread-existing",
        createdAt: "2026-07-17T10:00:00.000Z",
        updatedAt: "2026-07-17T10:00:00.000Z",
      }),
    ).resolves.toEqual({
      messageId: "message-existing",
      created: false,
      previousContent: "-# Managed by Prod · ticket:ticket-stale",
    });
    expect(edit).toHaveBeenCalledOnce();
    expect(editCollision).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("ticket:42"),
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("renames a legacy ticket thread to its numbered case name", async () => {
    const setName = vi.fn().mockResolvedValue(undefined);
    const mockGuild = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          type: ChannelType.PrivateThread,
          parentId: "hub-1",
          name: "ticket-ticketst",
          setName,
        }),
      },
    } as unknown as Guild;

    await createTicketProvisioningDiscord().updateTicketThreadName(mockGuild, {
      id: "ticket-stale",
      number: 42,
      guildId: "guild-1",
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
      status: "open",
      triageStatus: "collecting",
      threadId: "thread-existing",
      openingMessageId: "message-existing",
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:00:00.000Z",
    });

    expect(setName).toHaveBeenCalledWith("ticket-42", "Number Prod ticket 42");
  });

  it("rolls back only mutations owned by a failed thread recovery", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const setArchived = vi.fn().mockResolvedValue(undefined);
    const message = { id: "message-existing", edit };
    const thread = {
      type: ChannelType.PrivateThread,
      parentId: "hub-1",
      messages: { fetch: vi.fn().mockResolvedValue(message) },
      members: { remove },
      setArchived,
    };
    const mockGuild = {
      channels: { fetch: vi.fn().mockResolvedValue(thread) },
    } as unknown as Guild;
    const ticket = {
      id: "ticket-stale",
      number: 42,
      guildId: "guild-1",
      hubChannelId: "hub-1",
      reporterUserId: "reporter-1",
      originatingAlias: "issue",
      status: "provisioning",
      triageStatus: "collecting",
      threadId: "thread-existing",
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:00:00.000Z",
    } as const;

    await createTicketProvisioningDiscord().rollbackTicketThread(
      mockGuild,
      "thread-existing",
      ticket,
      { wasArchived: true, reporterWasMember: false },
      {
        messageId: "message-existing",
        created: false,
        previousContent: "previous instructions",
      },
    );

    expect(edit).toHaveBeenCalledWith({
      content: "previous instructions",
      allowedMentions: { parse: [] },
    });
    expect(remove).toHaveBeenCalledWith("reporter-1");
    expect(setArchived).toHaveBeenCalledWith(
      true,
      "Roll back failed Prod ticket recovery 42",
    );
  });

  it("removes control characters, neutralizes mentions, and caps summaries", () => {
    const sanitized = sanitizeTicketSummary(
      `  hello\u0000 @here ${"x".repeat(300)} `,
    )!;
    expect(sanitized).toContain("@\u200bhere");
    expect(sanitized).not.toContain("\u0000");
    expect([...sanitized]).toHaveLength(201);
  });
});
