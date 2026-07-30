#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off - Release artifact inspection is a synchronous, fail-closed CLI boundary.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const REQUIRED_PACKAGE_FILES = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/bin.mjs",
  "package/dist/client/index.html",
] as const;

const PRIVATE_RUNTIME_DEPENDENCIES = [
  "@shuv2code/contracts",
  "@shuv2code/shared",
  "@shuv2code/tailscale",
  "@shuv2code/web",
  "effect-acp",
  "effect-codex-app-server",
] as const;

const SENSITIVE_PACKAGE_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)(?:credentials?|secrets?)(?:[./]|$)/i,
  /(^|\/)id_rsa(?:\.|$)/i,
  /\.(?:key|p12|pfx|pem)$/i,
  /(^|\/)AuthKey_[^/]+\.p8$/i,
] as const;

interface PackedPackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly bin?: unknown;
  readonly dependencies?: unknown;
  readonly [key: string]: unknown;
}

export interface ReleasePackageInspection {
  readonly name: "shuv2code";
  readonly version: string;
  readonly fileCount: number;
}

export class ReleasePackageInspectionError extends Error {
  override readonly name = "ReleasePackageInspectionError";
}

function fail(message: string): never {
  throw new ReleasePackageInspectionError(message);
}

function recordOfStrings(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function validatePackedPackage(
  manifest: PackedPackageManifest,
  files: ReadonlyArray<string>,
  expectedVersion: string,
): ReleasePackageInspection {
  if (manifest.name !== "shuv2code") {
    fail(`Expected packed package name 'shuv2code', received '${String(manifest.name)}'.`);
  }
  if (manifest.version !== expectedVersion) {
    fail(
      `Expected packed package version '${expectedVersion}', received '${String(manifest.version)}'.`,
    );
  }

  const fileSet = new Set(files.map((file) => file.replace(/^\.\//, "")));
  for (const requiredFile of REQUIRED_PACKAGE_FILES) {
    if (!fileSet.has(requiredFile)) fail(`Packed package is missing '${requiredFile}'.`);
  }

  const sensitivePath = files.find((file) =>
    SENSITIVE_PACKAGE_PATH_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (sensitivePath !== undefined) {
    fail(`Packed package contains sensitive path '${sensitivePath}'.`);
  }

  const serializedManifest = JSON.stringify(manifest);
  if (/\b(?:workspace|catalog):/i.test(serializedManifest)) {
    fail("Packed package manifest contains an unresolved workspace: or catalog: protocol.");
  }

  const bins = recordOfStrings(manifest.bin);
  for (const binName of ["shuv2code", "s2c"] as const) {
    if (bins[binName] !== "./dist/bin.mjs") {
      fail(`Packed package bin '${binName}' must resolve to './dist/bin.mjs'.`);
    }
  }

  if (manifest.devDependencies !== undefined) {
    fail("Packed package manifest must not contain devDependencies.");
  }
  if (manifest.scripts !== undefined) {
    fail("Packed package manifest must not contain development or lifecycle scripts.");
  }

  for (const dependencyField of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ] as const) {
    const dependencies = recordOfStrings(manifest[dependencyField]);
    const privateDependency = PRIVATE_RUNTIME_DEPENDENCIES.find(
      (dependency) => dependency in dependencies,
    );
    if (privateDependency !== undefined) {
      fail(
        `Packed package retains private dependency '${privateDependency}' in '${dependencyField}'.`,
      );
    }
  }

  return {
    name: "shuv2code",
    version: expectedVersion,
    fileCount: fileSet.size,
  };
}

function runText(command: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`Command failed (${command} ${args.join(" ")}): ${detail || `exit ${result.status}`}`);
  }
  return result.stdout;
}

export function computeFileSha256(filePath: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");
}

function inspectTarball(tarballPath: string, expectedVersion: string): ReleasePackageInspection {
  const files = runText("tar", ["-tzf", tarballPath])
    .split("\n")
    .map((file) => file.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const manifestSource = runText("tar", ["-xOzf", tarballPath, "package/package.json"]);

  let manifest: PackedPackageManifest;
  try {
    manifest = JSON.parse(manifestSource) as PackedPackageManifest;
  } catch (cause) {
    fail(
      `Packed package manifest is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return validatePackedPackage(manifest, files, expectedVersion);
}

function verifyInstalledBinaries(tarballPath: string, expectedVersion: string): void {
  const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shuv2code-pack-install-"));
  const prefix = NodePath.join(tempRoot, "prefix");

  try {
    const install = NodeChildProcess.spawnSync(
      "npm",
      ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarballPath],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
        },
      },
    );
    if (install.status !== 0) {
      const detail = [install.stdout, install.stderr].filter(Boolean).join("\n").trim();
      fail(`Clean-prefix npm install failed: ${detail || `exit ${install.status}`}`);
    }

    for (const binName of ["shuv2code", "s2c"] as const) {
      const binPath =
        process.platform === "win32"
          ? NodePath.join(prefix, `${binName}.cmd`)
          : NodePath.join(prefix, "bin", binName);
      if (!NodeFS.existsSync(binPath)) fail(`Clean-prefix install did not expose '${binName}'.`);
      const versionOutput = runText(binPath, ["--version"]).trim();
      const expectedOutput = `shuv2code v${expectedVersion}`;
      if (versionOutput !== expectedOutput) {
        fail(
          `Installed '${binName} --version' returned '${versionOutput}', expected '${expectedOutput}'.`,
        );
      }
    }
  } finally {
    NodeFS.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export interface CliOptions {
  readonly tarballPath: string;
  readonly version: string;
  readonly digestOutputPath: string;
}

export function parseCliOptions(args: ReadonlyArray<string>): CliOptions {
  const allowedFlags = new Set(["--tarball", "--version", "--digest-output"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !allowedFlags.has(flag) ||
      value.startsWith("--") ||
      values.has(flag)
    ) {
      fail(
        "Usage: inspect-release-package --tarball <path> --version <semver> --digest-output <path>",
      );
    }
    values.set(flag, value);
  }

  const tarball = values.get("--tarball");
  const version = values.get("--version");
  const digestOutput = values.get("--digest-output");
  if (tarball === undefined || version === undefined || digestOutput === undefined) {
    fail("Required flags: --tarball <path> --version <semver> --digest-output <path>.");
  }

  return {
    tarballPath: NodePath.resolve(tarball),
    version,
    digestOutputPath: NodePath.resolve(digestOutput),
  };
}

function logEvent(event: string, fields: Readonly<Record<string, string | number>>): void {
  console.log(JSON.stringify({ component: "release-package-inspection", event, ...fields }));
}

export function inspectReleasePackage(options: CliOptions): ReleasePackageInspection & {
  readonly sha256: string;
  readonly digestOutputPath: string;
} {
  if (!NodeFS.existsSync(options.tarballPath)) {
    fail(`Release tarball does not exist: ${options.tarballPath}`);
  }

  const startedAt = Date.now();
  logEvent("inspection_started", {
    tarball: NodePath.basename(options.tarballPath),
    version: options.version,
  });

  const inspection = inspectTarball(options.tarballPath, options.version);
  verifyInstalledBinaries(options.tarballPath, options.version);
  const sha256 = computeFileSha256(options.tarballPath);
  NodeFS.mkdirSync(NodePath.dirname(options.digestOutputPath), { recursive: true });
  NodeFS.writeFileSync(
    options.digestOutputPath,
    `${sha256}  ${NodePath.basename(options.tarballPath)}\n`,
  );

  logEvent("inspection_completed", {
    tarball: NodePath.basename(options.tarballPath),
    version: options.version,
    file_count: inspection.fileCount,
    sha256,
    duration_ms: Date.now() - startedAt,
  });

  return { ...inspection, sha256, digestOutputPath: options.digestOutputPath };
}

if (import.meta.main) {
  try {
    inspectReleasePackage(parseCliOptions(process.argv.slice(2)));
  } catch (cause) {
    console.error(
      JSON.stringify({
        component: "release-package-inspection",
        event: "inspection_failed",
        error_class: cause instanceof Error ? cause.name : "UnknownError",
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    process.exitCode = 1;
  }
}
