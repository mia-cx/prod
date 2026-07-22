import { spawn } from "node:child_process";
import { readdirSync, watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  const explicitWatchDirectories = process.argv.slice(3).map((directory) =>
    resolve(directory),
  );
  const packageDirectory = resolve(
    process.env.DEV_WATCH_PACKAGES_ROOT ??
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages"),
  );
  const packageSourceDirectories = readdirSync(packageDirectory, {
    withFileTypes: true,
  })
    .filter((item) => item.isDirectory())
    .map((item) => resolve(packageDirectory, item.name, "src"));
  const watchDirectories = [
    sourceDirectory,
    ...(explicitWatchDirectories.length === 0
      ? packageSourceDirectories
      : explicitWatchDirectories),
  ];
  const watchers = watchDirectories.map((directory) =>
    watch(directory, { recursive: true }),
  );
  const closeWatchers = () => {
    for (const watcher of watchers) watcher.close();
  };

  const start = () => {
    child = spawn(
      process.execPath,
      ["--conditions=development", "--import", "tsx", entry],
      {
        detached: process.platform !== "win32",
        stdio: "inherit",
      },
    );

    child.once("error", (error) => {
      console.error(error);
      stopping = true;
      closeWatchers();
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
        closeWatchers();
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

  for (const watcher of watchers) {
    watcher.on("change", () => {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(restart, 75);
    });
    watcher.on("error", (error) => {
      console.error(error);
      stopping = true;
      closeWatchers();
      child?.kill("SIGTERM");
      process.exitCode = 1;
    });
  }

  const stop = (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearTimeout(restartTimer);
    closeWatchers();
    child?.kill(signal);
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  start();
}
