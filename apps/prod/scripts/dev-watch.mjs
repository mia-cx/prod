import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { dirname, resolve } from "node:path";

const entry = process.argv[2];

if (entry === undefined) {
  console.error("Usage: node scripts/dev-watch.mjs <entry>");
  process.exitCode = 1;
} else {
  let child;
  let restartTimer;
  let restarting = false;
  let stopping = false;

  const sourceDirectory = dirname(resolve(entry));
  const watcher = watch(sourceDirectory, { recursive: true });

  const start = () => {
    child = spawn(process.execPath, ["--import", "tsx", entry], {
      detached: process.platform !== "win32",
      stdio: "inherit",
    });

    child.once("error", (error) => {
      console.error(error);
      stopping = true;
      watcher.close();
      process.exitCode = 1;
    });

    child.once("exit", (code, signal) => {
      child = undefined;

      if (restarting && !stopping) {
        restarting = false;
        start();
        return;
      }

      if (!stopping) {
        watcher.close();
        process.exitCode = code ?? (signal === null ? 0 : 1);
      }
    });
  };

  const restart = () => {
    if (stopping || restarting) {
      return;
    }
    restarting = true;
    child?.kill("SIGTERM");
  };

  watcher.on("change", () => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(restart, 75);
  });
  watcher.on("error", (error) => {
    console.error(error);
    stopping = true;
    child?.kill("SIGTERM");
    process.exitCode = 1;
  });

  const stop = (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearTimeout(restartTimer);
    watcher.close();
    child?.kill(signal);
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  start();
}
