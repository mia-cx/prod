import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const waitForOutput = (
  output: () => string,
  expected: string,
  timeoutMs = 5_000,
): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (output().includes(expected)) {
        resolvePromise();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${JSON.stringify(expected)}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });

describe("the app dev process", () => {
  it("lets the child finish graceful shutdown on SIGINT", async () => {
    const packageJson = await import("../package.json", {
      with: { type: "json" },
    });
    const configuredCommand = packageJson.default.scripts.dev as string;
    expect(configuredCommand).toBe("node scripts/dev-watch.mjs src/main.ts");
    let output = "";
    let closed = false;
    const child = spawn(
      process.execPath,
      ["scripts/dev-watch.mjs", "test/fixtures/graceful-process.ts"],
      {
        cwd: appDirectory,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const close = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveClose) => {
      child.once("close", (code, signal) => {
        closed = true;
        resolveClose({ code, signal });
      });
    });

    try {
      await waitForOutput(() => output, "fixture ready");
      process.kill(-child.pid!, "SIGINT");
      const result = await close;

      expect(result).toEqual({ code: 0, signal: null });
      expect(output).toContain("fixture stopping");
      expect(output).toContain("fixture stopped");
    } finally {
      if (!closed) {
        process.kill(-child.pid!, "SIGKILL");
        await close;
      }
    }
  }, 10_000);
});
