import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { startProd } from "../src/application.js";
import type { ProdConfig } from "../src/config.js";
import { openDatabase, type ProdDatabase } from "../src/database.js";
import type { DiscordGateway } from "../src/discord.js";
import { createLogger } from "../src/logger.js";

const config: ProdConfig = {
  discordToken: "development-secret-token",
  discordClientId: "123456789012345678",
  textCommandPrefix: "!",
  databaseUrl: ":memory:",
  logLevel: "debug",
};

const captureLogger = () => {
  const output: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output.push(String(chunk));
      callback();
    },
  });
  return {
    logger: createLogger(
      { level: config.logLevel, secrets: [config.discordToken] },
      destination,
    ),
    output,
  };
};

describe("startProd", () => {
  it("migrates before connecting, reports readiness, and stops idempotently", async () => {
    const sequence: string[] = [];
    const gateway: DiscordGateway = {
      connect: vi.fn(async (token) => {
        expect(token).toBe(config.discordToken);
        sequence.push("connect");
        return { userId: "345678901234567890", tag: "Prod#0001" };
      }),
      close: vi.fn(async () => {
        sequence.push("gateway:close");
      }),
    };
    const connection = openDatabase(":memory:");
    const closeDatabase = vi.fn(connection.close);
    const { logger, output } = captureLogger();

    const application = await startProd(config, {
      logger,
      gateway,
      openDatabase: () => ({ ...connection, close: closeDatabase }),
      migrate: async (_database, onHistoryApplied, signal) => {
        expect(signal.aborted).toBe(false);
        sequence.push("migrate");
        onHistoryApplied("fixture");
      },
    });

    expect(sequence).toEqual(["migrate", "connect"]);
    expect(output.join("")).toContain("Prod ready");
    expect(output.join("")).toContain('"actionCount":1');
    expect(output.join("")).not.toContain(config.discordToken);

    await application.stop("test");
    await application.stop("duplicate");

    expect(gateway.close).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(sequence).toEqual(["migrate", "connect", "gateway:close"]);
  });

  it("closes acquired resources when Discord startup fails", async () => {
    const gateway: DiscordGateway = {
      connect: vi.fn(async () => {
        throw new Error(`Discord rejected ${config.discordToken}`);
      }),
      close: vi.fn(async () => undefined),
    };
    const connection = openDatabase(":memory:");
    const closeDatabase = vi.fn(connection.close);
    const { logger } = captureLogger();

    await expect(
      startProd(config, {
        logger,
        gateway,
        openDatabase: () => ({ ...connection, close: closeDatabase }),
      }),
    ).rejects.toThrow("Discord rejected");

    expect(gateway.close).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it("cancels startup and closes partial resources exactly once", async () => {
    const controller = new AbortController();
    const reason = new DOMException("shutdown", "AbortError");
    const gateway: DiscordGateway = {
      connect: vi.fn(async () => ({
        userId: "345678901234567890",
        tag: "Prod#0001",
      })),
      close: vi.fn(async () => undefined),
    };
    const connection = openDatabase(":memory:");
    const closeDatabase = vi.fn(connection.close);
    const { logger, output } = captureLogger();
    const migrate = vi.fn(
      async (
        _database: ProdDatabase,
        _onHistoryApplied: (owner: string) => void,
        signal: AbortSignal,
      ) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const startup = startProd(
      config,
      {
        logger,
        gateway,
        openDatabase: () => ({ ...connection, close: closeDatabase }),
        migrate,
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(migrate).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(startup).rejects.toBe(reason);
    expect(gateway.connect).not.toHaveBeenCalled();
    expect(gateway.close).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(output.join("")).not.toContain("Prod ready");
  });
});
