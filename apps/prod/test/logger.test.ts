import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.js";

describe("createLogger", () => {
  it("redacts configured secret fields and secrets embedded in errors", () => {
    const output: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output.push(String(chunk));
        callback();
      },
    });
    const secret = "development-secret-token";
    const logger = createLogger({ level: "info", secrets: [secret] }, destination);

    logger.info(
      {
        discordToken: secret,
        config: { DISCORD_TOKEN: secret },
        err: new Error(`Discord rejected ${secret}`),
      },
      "startup failed",
    );

    const serialized = output.join("");
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[Redacted]");
    expect(JSON.parse(serialized)).toMatchObject({
      name: "prod",
      msg: "startup failed",
      discordToken: "[Redacted]",
      config: { DISCORD_TOKEN: "[Redacted]" },
    });
  });
});

