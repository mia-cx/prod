import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type ProcessResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

class ProcessTimeoutError extends Error {
  override readonly name = "ProcessTimeoutError";
}

const withTimeout = <Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  description: string,
): Promise<Value> =>
  new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new ProcessTimeoutError(`Timed out waiting for ${description}`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const settlesWithin = async <Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  description: string,
): Promise<boolean> => {
  try {
    await withTimeout(promise, timeoutMs, description);
    return true;
  } catch (error) {
    if (error instanceof ProcessTimeoutError) {
      return false;
    }
    throw error;
  }
};

const killProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return;
    }
    throw error;
  }
};

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

const startDevFixture = (entry: string) => {
  let output = "";
  let fixturePid: number | undefined;
  let result: ProcessResult | undefined;
  const child = spawn(process.execPath, ["scripts/dev-watch.mjs", entry], {
    cwd: appDirectory,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const wrapperPid = child.pid;
  if (wrapperPid === undefined) {
    throw new Error("Dev-process wrapper did not receive a process ID");
  }

  const capture = (chunk: Buffer): void => {
    output += chunk.toString();
    const match = /fixture pid=(\d+)/u.exec(output);
    if (match?.[1]) {
      fixturePid = Number(match[1]);
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  const close = new Promise<ProcessResult>((resolveClose) => {
    child.once("close", (code, signal) => {
      result = { code, signal };
      resolveClose(result);
    });
  });

  const waitForClose = (timeoutMs = 5_000): Promise<ProcessResult> =>
    withTimeout(close, timeoutMs, "the dev-process wrapper to close");

  return {
    wrapperPid,
    output: () => output,
    waitForOutput: (expected: string, timeoutMs?: number) =>
      waitForOutput(() => output, expected, timeoutMs),
    fixturePid: () => {
      if (fixturePid === undefined) {
        throw new Error("Fixture process ID was not captured");
      }
      return fixturePid;
    },
    signal: (signal: NodeJS.Signals) => killProcessGroup(wrapperPid, signal),
    waitForClose,
    cleanup: async () => {
      if (result) {
        return;
      }

      killProcessGroup(wrapperPid, "SIGTERM");
      if (await settlesWithin(close, 250, "graceful fixture cleanup")) {
        return;
      }

      if (fixturePid === undefined) {
        throw new Error("Cannot force fixture cleanup without its process ID");
      }
      killProcessGroup(fixturePid, "SIGKILL");
      killProcessGroup(wrapperPid, "SIGKILL");
      await waitForClose(1_000);
    },
  };
};

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
};

describe("the app dev process", () => {
  it("lets the child finish graceful shutdown on SIGINT", async () => {
    const packageJson = await import("../package.json", {
      with: { type: "json" },
    });
    const configuredCommand = packageJson.default.scripts.dev as string;
    expect(configuredCommand).toBe("node scripts/dev-watch.mjs src/main.ts");
    const fixture = startDevFixture("test/fixtures/graceful-process.ts");

    try {
      await fixture.waitForOutput("fixture ready");
      fixture.signal("SIGINT");
      const result = await fixture.waitForClose();

      expect(result).toEqual({ code: 0, signal: null });
      expect(fixture.output()).toContain("fixture stopping");
      expect(fixture.output()).toContain("fixture stopped");
    } finally {
      await fixture.cleanup();
    }
  }, 15_000);

  it("force-cleans the wrapper and detached fixture when shutdown stalls", async () => {
    const fixture = startDevFixture("test/fixtures/stubborn-process.ts");
    let fixturePid: number | undefined;

    try {
      await fixture.waitForOutput("fixture ready");
      fixturePid = fixture.fixturePid();
      fixture.signal("SIGINT");
      await expect(fixture.waitForClose(100)).rejects.toThrow(
        "Timed out waiting for the dev-process wrapper to close",
      );
    } finally {
      await fixture.cleanup();
    }

    expect(isProcessRunning(fixture.wrapperPid)).toBe(false);
    expect(fixturePid).toBeDefined();
    if (fixturePid === undefined) {
      throw new Error("Fixture process ID was not captured before cleanup");
    }
    expect(isProcessRunning(fixturePid)).toBe(false);
  }, 10_000);

  it("reserves enough time to clean up after readiness times out", async () => {
    const fixture = startDevFixture("test/fixtures/delayed-ready-process.ts");
    let fixturePid: number | undefined;
    let readinessError: unknown;

    try {
      await fixture.waitForOutput("fixture pid=");
      fixturePid = fixture.fixturePid();
      await fixture.waitForOutput("fixture ready", 100);
    } catch (error) {
      readinessError = error;
    } finally {
      await fixture.cleanup();
    }

    expect(readinessError).toEqual(
      new Error('Timed out waiting for "fixture ready"'),
    );
    expect(isProcessRunning(fixture.wrapperPid)).toBe(false);
    expect(fixturePid).toBeDefined();
    if (fixturePid === undefined) {
      throw new Error("Fixture process ID was not captured before cleanup");
    }
    expect(isProcessRunning(fixturePid)).toBe(false);
  }, 10_000);
});
