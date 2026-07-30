#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off - Deterministic release staging uses synchronous filesystem boundaries.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parse as parseYaml } from "yaml";

import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";
import { classifyReleaseVersion } from "./lib/release-version.ts";

interface SourcePackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly description?: unknown;
  readonly keywords?: unknown;
  readonly homepage?: unknown;
  readonly bugs?: unknown;
  readonly license?: unknown;
  readonly repository?: unknown;
  readonly bin?: unknown;
  readonly files?: unknown;
  readonly type?: unknown;
  readonly publishConfig?: unknown;
  readonly engines?: unknown;
  readonly author?: unknown;
  readonly funding?: unknown;
  readonly dependencies?: unknown;
}

interface WorkspaceManifest {
  readonly catalog?: unknown;
}

export class ReleasePackagePreparationError extends Error {
  override readonly name = "ReleasePackagePreparationError";
}

function fail(message: string): never {
  throw new ReleasePackagePreparationError(message);
}

function recordOfStrings(value: unknown, field: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`Expected '${field}' to be an object.`);
  }
  const entries = Object.entries(value);
  if (entries.some((entry) => typeof entry[1] !== "string")) {
    fail(`Expected every '${field}' value to be a string.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function createReleasePackageManifest(
  source: SourcePackageManifest,
  catalog: Record<string, string>,
  expectedVersion: string,
): Record<string, unknown> {
  const classified = classifyReleaseVersion(expectedVersion);
  if (source.name !== "shuv2code") fail("Source package name must be 'shuv2code'.");
  if (source.version !== classified.version) {
    fail(
      `Source package version '${String(source.version)}' does not match '${classified.version}'.`,
    );
  }

  const dependencies = resolveCatalogDependencies(
    recordOfStrings(source.dependencies, "dependencies"),
    catalog,
    "apps/server",
  );

  const fields = {
    name: source.name,
    version: classified.version,
    description: source.description,
    keywords: source.keywords,
    homepage: source.homepage,
    bugs: source.bugs,
    license: source.license,
    repository: source.repository,
    bin: source.bin,
    files: source.files,
    type: source.type,
    publishConfig: source.publishConfig,
    engines: source.engines,
    author: source.author,
    funding: source.funding,
    dependencies,
  };

  return Object.fromEntries(Object.entries(fields).filter((entry) => entry[1] !== undefined));
}

interface PrepareOptions {
  readonly outputDirectory: string;
  readonly version: string;
  readonly rootDirectory: string;
}

function parseOptions(args: ReadonlyArray<string>): PrepareOptions {
  const allowedFlags = new Set(["--output", "--version", "--root"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !allowedFlags.has(flag) ||
      value.startsWith("--")
    ) {
      fail(
        "Usage: prepare-release-package --output <directory> --version <semver> [--root <directory>]",
      );
    }
    values.set(flag, value);
  }

  const output = values.get("--output");
  const version = values.get("--version");
  if (output === undefined || version === undefined) {
    fail("Required flags: --output <directory> --version <semver>.");
  }

  return {
    outputDirectory: NodePath.resolve(output),
    version,
    rootDirectory: NodePath.resolve(values.get("--root") ?? process.cwd()),
  };
}

function readJson(filePath: string): SourcePackageManifest {
  try {
    return JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as SourcePackageManifest;
  } catch (cause) {
    fail(
      `Unable to read JSON '${filePath}': ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function readCatalog(filePath: string): Record<string, string> {
  let workspace: WorkspaceManifest;
  try {
    workspace = parseYaml(NodeFS.readFileSync(filePath, "utf8")) as WorkspaceManifest;
  } catch (cause) {
    fail(
      `Unable to read workspace catalog '${filePath}': ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return recordOfStrings(workspace.catalog ?? {}, "catalog");
}

function copyRequired(sourcePath: string, targetPath: string): void {
  if (!NodeFS.existsSync(sourcePath))
    fail(`Required release package input is missing: ${sourcePath}`);
  NodeFS.cpSync(sourcePath, targetPath, { recursive: true });
}

export function prepareReleasePackage(options: PrepareOptions): Record<string, unknown> {
  const startedAt = Date.now();
  const serverDirectory = NodePath.join(options.rootDirectory, "apps/server");
  const sourceManifest = readJson(NodePath.join(serverDirectory, "package.json"));
  const catalog = readCatalog(NodePath.join(options.rootDirectory, "pnpm-workspace.yaml"));
  const releaseManifest = createReleasePackageManifest(sourceManifest, catalog, options.version);

  NodeFS.rmSync(options.outputDirectory, { recursive: true, force: true });
  NodeFS.mkdirSync(options.outputDirectory, { recursive: true });
  copyRequired(
    NodePath.join(serverDirectory, "dist"),
    NodePath.join(options.outputDirectory, "dist"),
  );
  copyRequired(
    NodePath.join(serverDirectory, "README.md"),
    NodePath.join(options.outputDirectory, "README.md"),
  );
  copyRequired(
    NodePath.join(serverDirectory, "LICENSE"),
    NodePath.join(options.outputDirectory, "LICENSE"),
  );
  NodeFS.writeFileSync(
    NodePath.join(options.outputDirectory, "package.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  );

  console.log(
    JSON.stringify({
      component: "release-package-preparation",
      event: "package_staged",
      version: options.version,
      output_directory: options.outputDirectory,
      dependency_count: Object.keys(recordOfStrings(releaseManifest.dependencies, "dependencies"))
        .length,
      duration_ms: Date.now() - startedAt,
    }),
  );
  return releaseManifest;
}

if (import.meta.main) {
  try {
    prepareReleasePackage(parseOptions(process.argv.slice(2)));
  } catch (cause) {
    console.error(
      JSON.stringify({
        component: "release-package-preparation",
        event: "package_staging_failed",
        error_class: cause instanceof Error ? cause.name : "UnknownError",
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    process.exitCode = 1;
  }
}
