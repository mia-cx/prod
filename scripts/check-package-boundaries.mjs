import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(root, "packages");
const errors = [];

const expectedPackages = new Set([
  "@prod/authorization",
  "@prod/config-eslint",
  "@prod/config-typescript",
  "@prod/discord-actions",
  "@prod/discord-actions-ai",
  "@prod/discord-settings",
  "@prod/model-config",
]);

const allowedInternalDependencies = new Map([
  ["@prod/authorization", new Set()],
  ["@prod/config-eslint", new Set()],
  ["@prod/config-typescript", new Set()],
  ["@prod/discord-actions", new Set()],
  ["@prod/discord-actions-ai", new Set(["@prod/discord-actions"])],
  ["@prod/discord-settings", new Set()],
  ["@prod/model-config", new Set(["@prod/discord-settings"])],
]);

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const listFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return nested.flat();
};

const packageDirectories = (
  await readdir(packagesRoot, { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesRoot, entry.name));

const packageManifests = await Promise.all(
  packageDirectories.map(async (directory) => ({
    directory,
    manifest: await readJson(join(directory, "package.json")),
  })),
);

const actualPackages = new Set(packageManifests.map(({ manifest }) => manifest.name));
for (const packageName of expectedPackages) {
  if (!actualPackages.has(packageName)) {
    errors.push(`missing planned package ${packageName}`);
  }
}
for (const packageName of actualPackages) {
  if (!expectedPackages.has(packageName)) {
    errors.push(`unexpected reusable package ${packageName}`);
  }
}

for (const { directory, manifest } of packageManifests) {
  const label = relative(root, directory);
  if (manifest.private !== true) {
    errors.push(`${label} must remain private for the MVP`);
  }

  const rootExport = manifest.exports?.["."];
  if (
    typeof rootExport?.import !== "string" ||
    !rootExport.import.startsWith("./dist/") ||
    typeof rootExport?.types !== "string" ||
    !rootExport.types.startsWith("./dist/")
  ) {
    errors.push(`${label} must export compiled JavaScript and declarations from dist`);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes("dist")) {
    errors.push(`${label} must pack only its dist output`);
  }

  for (const script of ["build", "lint", "typecheck", "test", "pack:check"]) {
    if (typeof manifest.scripts?.[script] !== "string") {
      errors.push(`${label} is missing its ${script} script`);
    }
  }

  const internalDependencies = Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  }).filter(([name]) => name.startsWith("@prod/"));
  const allowed = allowedInternalDependencies.get(manifest.name) ?? new Set();
  for (const [dependency, version] of internalDependencies) {
    if (!allowed.has(dependency)) {
      errors.push(`${label} may not depend on ${dependency}`);
    }
    if (version !== "workspace:*") {
      errors.push(`${label} must declare ${dependency} with workspace:*`);
    }
  }

  const sourceRoot = join(directory, "src");
  for (const file of (await listFiles(sourceRoot)).filter((path) => path.endsWith(".ts"))) {
    const source = await readFile(file, "utf8");
    if (source.includes("apps/prod") || /@prod\/[^"']+\/src(?:\/|["'])/.test(source)) {
      errors.push(`${relative(root, file)} imports an application or package internal path`);
    }

    for (const match of source.matchAll(/["'](\.\.?\/[^"']+)["']/g)) {
      const specifier = match[1];
      const resolvedImport = resolve(dirname(file), specifier);
      if (resolvedImport !== directory && !resolvedImport.startsWith(`${directory}${sep}`)) {
        errors.push(`${relative(root, file)} crosses its package boundary via ${specifier}`);
      }
    }
  }
}

const appManifest = await readJson(join(root, "apps/prod/package.json"));
const expectedAppDependencies = new Set([
  "@prod/authorization",
  "@prod/discord-actions",
  "@prod/discord-actions-ai",
  "@prod/discord-settings",
  "@prod/model-config",
]);
for (const [dependency, version] of Object.entries(appManifest.dependencies ?? {}).filter(
  ([name]) => name.startsWith("@prod/"),
)) {
  if (!expectedAppDependencies.has(dependency)) {
    errors.push(`apps/prod may not depend on ${dependency}`);
  }
  if (version !== "workspace:*") {
    errors.push(`apps/prod must declare ${dependency} with workspace:*`);
  }
}
for (const dependency of expectedAppDependencies) {
  if (appManifest.dependencies?.[dependency] !== "workspace:*") {
    errors.push(`apps/prod is missing workspace dependency ${dependency}`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Package boundaries valid for ${packageManifests.length} reusable packages.`);
}

