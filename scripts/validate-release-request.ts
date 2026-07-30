#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  InvalidReleaseVersionError,
  ReleaseChannelMismatchError,
  assertReleaseChannel,
  classifyReleaseVersion,
} from "./lib/release-version.ts";

export class ReleaseRequestValidationError extends Schema.TaggedErrorClass<ReleaseRequestValidationError>()(
  "ReleaseRequestValidationError",
  {
    version: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : `Invalid release request for version '${this.version}'.`;
  }
}

export class ReleaseRequestGitHubOutputConfigError extends Schema.TaggedErrorClass<ReleaseRequestGitHubOutputConfigError>()(
  "ReleaseRequestGitHubOutputConfigError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve GITHUB_OUTPUT for release request validation.";
  }
}

export class ReleaseRequestGitHubOutputWriteError extends Schema.TaggedErrorClass<ReleaseRequestGitHubOutputWriteError>()(
  "ReleaseRequestGitHubOutputWriteError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to append release request outputs to '${this.filePath}'.`;
  }
}

export const validateReleaseRequest = (version: string, channel?: string) => {
  try {
    const classified =
      channel === undefined
        ? classifyReleaseVersion(version)
        : assertReleaseChannel(version, channel);
    return Effect.succeed(classified);
  } catch (cause) {
    if (
      cause instanceof InvalidReleaseVersionError ||
      cause instanceof ReleaseChannelMismatchError
    ) {
      return Effect.fail(
        new ReleaseRequestValidationError({
          version,
          cause,
        }),
      );
    }
    return Effect.fail(
      new ReleaseRequestValidationError({
        version,
        cause,
      }),
    );
  }
};

export const writeReleaseRequestOutput = Effect.fn("writeReleaseRequestOutput")(function* (
  version: string,
  channel: string | undefined,
  writeGithubOutput: boolean,
) {
  const classified = yield* validateReleaseRequest(version, channel);
  const entries = [
    ["version", classified.version],
    ["npm_dist_tag", classified.npmDistTag],
    ["github_prerelease", String(classified.githubPrerelease)],
    ["github_make_latest", String(classified.githubMakeLatest)],
    ["release_class", classified.class],
  ] as const;

  if (writeGithubOutput) {
    const fs = yield* FileSystem.FileSystem;
    const githubOutputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT").pipe(
      Effect.mapError(
        (cause) =>
          new ReleaseRequestGitHubOutputConfigError({
            cause,
          }),
      ),
    );
    const serialized = entries.map(([key, value]) => `${key}=${value}\n`).join("");
    yield* fs.writeFileString(githubOutputPath, serialized, { flag: "a" }).pipe(
      Effect.mapError(
        (cause) =>
          new ReleaseRequestGitHubOutputWriteError({
            filePath: githubOutputPath,
            cause,
          }),
      ),
    );
  } else {
    for (const [key, value] of entries) {
      yield* Console.log(`${key}=${value}`);
    }
  }

  return classified;
});

const command = Command.make(
  "validate-release-request",
  {
    version: Argument.string("version").pipe(
      Argument.withDescription("Exact release version to validate."),
    ),
    channel: Flag.string("channel").pipe(
      Flag.withDescription("Optional npm dist-tag that must match the SemVer-derived channel."),
      Flag.optional,
    ),
    githubOutput: Flag.boolean("github-output").pipe(
      Flag.withDescription("Write values to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
  },
  ({ version, channel, githubOutput }) =>
    writeReleaseRequestOutput(version, Option.getOrUndefined(channel), githubOutput),
).pipe(Command.withDescription("Validate release version/channel mapping."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
