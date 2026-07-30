#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { fromJsonStringPretty } from "@shuv2code/shared/schemaJson";

import { InvalidReleaseVersionError, classifyReleaseVersion } from "./lib/release-version.ts";

export class ReleasePackageManifestError extends Schema.TaggedErrorClass<ReleasePackageManifestError>()(
  "ReleasePackageManifestError",
  {
    operation: Schema.Literals(["read", "decode", "encode", "write"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} release package manifest '${this.filePath}'.`;
  }
}

export class ReleaseMobileAppConfigError extends Schema.TaggedErrorClass<ReleaseMobileAppConfigError>()(
  "ReleaseMobileAppConfigError",
  {
    operation: Schema.Literals(["read", "replace", "write"]),
    filePath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} mobile app config version at '${this.filePath}'.`;
  }
}

export class ReleaseVersionValidationError extends Schema.TaggedErrorClass<ReleaseVersionValidationError>()(
  "ReleaseVersionValidationError",
  {
    version: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : `Invalid release version '${this.version}'.`;
  }
}

export class ReleaseGitHubOutputConfigurationError extends Schema.TaggedErrorClass<ReleaseGitHubOutputConfigurationError>()(
  "ReleaseGitHubOutputConfigurationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to resolve GITHUB_OUTPUT for release package version output.";
  }
}

export class ReleaseGitHubOutputWriteError extends Schema.TaggedErrorClass<ReleaseGitHubOutputWriteError>()(
  "ReleaseGitHubOutputWriteError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to append release package version output to '${this.filePath}'.`;
  }
}

export const releasePackageFiles = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
  "packages/shared/package.json",
  "packages/tailscale/package.json",
  "packages/effect-acp/package.json",
  "packages/effect-codex-app-server/package.json",
] as const;

export const mobileAppConfigFile = "apps/mobile/app.config.ts" as const;

/** Matches the Expo `version: "..."` field in `apps/mobile/app.config.ts`. */
export const mobileAppConfigVersionPattern = /^(\s*version:\s*")([^"]+)("\s*,\s*)$/m;

interface UpdateReleasePackageVersionsOptions {
  readonly rootDir?: string | undefined;
}

const PackageJsonSchema = Schema.Record(Schema.String, Schema.Unknown);
const PackageJsonPrettyJson = fromJsonStringPretty(PackageJsonSchema);
const decodePackageJson = Schema.decodeUnknownEffect(PackageJsonPrettyJson);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

const validateReleaseVersion = (version: string) =>
  Effect.try({
    try: () => classifyReleaseVersion(version).version,
    catch: (cause) =>
      new ReleaseVersionValidationError({
        version,
        cause: cause instanceof InvalidReleaseVersionError ? cause : cause,
      }),
  });

export const updateMobileAppConfigVersion = Effect.fn("updateMobileAppConfigVersion")(function* (
  version: string,
  options: UpdateReleasePackageVersionsOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const filePath = path.join(rootDir, mobileAppConfigFile);
  const source = yield* fs.readFileString(filePath).pipe(
    Effect.mapError(
      (cause) =>
        new ReleaseMobileAppConfigError({
          operation: "read",
          filePath,
          cause,
        }),
    ),
  );

  const match = mobileAppConfigVersionPattern.exec(source);
  if (!match) {
    return yield* Effect.fail(
      new ReleaseMobileAppConfigError({
        operation: "replace",
        filePath,
      }),
    );
  }

  const currentVersion = match[2];
  if (currentVersion === version) {
    return { changed: false as const };
  }

  const nextSource = source.replace(mobileAppConfigVersionPattern, `$1${version}$3`);
  if (nextSource === source || !mobileAppConfigVersionPattern.test(nextSource)) {
    return yield* Effect.fail(
      new ReleaseMobileAppConfigError({
        operation: "replace",
        filePath,
      }),
    );
  }

  yield* fs.writeFileString(filePath, nextSource).pipe(
    Effect.mapError(
      (cause) =>
        new ReleaseMobileAppConfigError({
          operation: "write",
          filePath,
          cause,
        }),
    ),
  );
  return { changed: true as const };
});

export const updateReleasePackageVersions = Effect.fn("updateReleasePackageVersions")(function* (
  version: string,
  options: UpdateReleasePackageVersionsOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const normalizedVersion = yield* validateReleaseVersion(version);
  let changed = false;

  for (const relativePath of releasePackageFiles) {
    const filePath = path.join(rootDir, relativePath);
    const packageJsonText = yield* fs.readFileString(filePath).pipe(
      Effect.mapError(
        (cause) =>
          new ReleasePackageManifestError({
            operation: "read",
            filePath,
            cause,
          }),
      ),
    );
    const packageJson = yield* decodePackageJson(packageJsonText).pipe(
      Effect.mapError(
        (cause) =>
          new ReleasePackageManifestError({
            operation: "decode",
            filePath,
            cause,
          }),
      ),
    );
    if (packageJson.version === normalizedVersion) {
      continue;
    }

    const packageJsonString = yield* encodePackageJson({
      ...packageJson,
      version: normalizedVersion,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ReleasePackageManifestError({
            operation: "encode",
            filePath,
            cause,
          }),
      ),
    );
    yield* fs.writeFileString(filePath, `${packageJsonString}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new ReleasePackageManifestError({
            operation: "write",
            filePath,
            cause,
          }),
      ),
    );
    changed = true;
  }

  const mobileResult = yield* updateMobileAppConfigVersion(normalizedVersion, {
    rootDir,
  });
  if (mobileResult.changed) {
    changed = true;
  }

  return { changed, version: normalizedVersion };
});

const writeGithubOutput = Effect.fn("writeGithubOutput")(function* (changed: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const githubOutputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT").pipe(
    Effect.mapError(
      (cause) =>
        new ReleaseGitHubOutputConfigurationError({
          cause,
        }),
    ),
  );
  yield* fs.writeFileString(githubOutputPath, `changed=${changed}\n`, { flag: "a" }).pipe(
    Effect.mapError(
      (cause) =>
        new ReleaseGitHubOutputWriteError({
          filePath: githubOutputPath,
          cause,
        }),
    ),
  );
});

export const updateReleasePackageVersionsCommand = Command.make(
  "update-release-package-versions",
  {
    version: Argument.string("version").pipe(
      Argument.withDescription(
        "Release version to write into each releasable package.json and mobile app config.",
      ),
    ),
    root: Flag.string("root").pipe(
      Flag.withDescription("Workspace root used to resolve the release package manifests."),
      Flag.optional,
    ),
    githubOutput: Flag.boolean("github-output").pipe(
      Flag.withDescription("Append changed=<boolean> to GITHUB_OUTPUT."),
      Flag.withDefault(false),
    ),
  },
  ({ version, root, githubOutput }) =>
    updateReleasePackageVersions(version, {
      rootDir: Option.getOrUndefined(root),
    }).pipe(
      Effect.tap(({ changed }) =>
        changed
          ? Effect.void
          : Console.log("All package.json versions already match release version."),
      ),
      Effect.tap(({ changed }) => (githubOutput ? writeGithubOutput(changed) : Effect.void)),
    ),
).pipe(Command.withDescription("Update release package versions across the workspace."));

if (import.meta.main) {
  Command.run(updateReleasePackageVersionsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
