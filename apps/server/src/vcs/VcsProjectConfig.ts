import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  VcsDriverKind,
  type VcsDriverKind as VcsDriverKindType,
  type VcsSelectableKind,
} from "@shuv2code/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@shuv2code/shared/schemaJson";
import { writeFileStringAtomically } from "../atomicWrite.ts";

const ProjectVcsConfig = Schema.Struct({
  vcs: Schema.optional(
    Schema.Struct({
      kind: Schema.optional(VcsDriverKind),
    }),
  ),
  vcsKind: Schema.optional(VcsDriverKind),
});
const ProjectVcsConfigJson = fromLenientJson(ProjectVcsConfig);
const ProjectVcsConfigPrettyJson = fromJsonStringPretty(ProjectVcsConfig);
const decodeProjectVcsConfigJson = Schema.decodeUnknownEffect(ProjectVcsConfigJson);
const encodeProjectVcsConfigJson = Schema.encodeEffect(ProjectVcsConfigPrettyJson);

type ProjectVcsConfigFile = typeof ProjectVcsConfig.Type;

export interface VcsProjectConfigResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKindType | "auto";
}

export interface VcsProjectConfigSetInput {
  readonly cwd: string;
  readonly kind: VcsSelectableKind | null;
}

export class VcsProjectConfigError extends Schema.TaggedErrorClass<VcsProjectConfigError>()(
  "VcsProjectConfigError",
  {
    operation: Schema.Literals(["inspect", "read", "decode", "encode", "prepare", "write"]),
    cwd: Schema.String,
    configPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} VCS project config at ${this.configPath}.`;
  }
}

export class VcsProjectConfig extends Context.Service<
  VcsProjectConfig,
  {
    readonly resolveKind: (
      input: VcsProjectConfigResolveInput,
    ) => Effect.Effect<VcsDriverKindType | "auto">;
    readonly setKind: (
      input: VcsProjectConfigSetInput,
    ) => Effect.Effect<void, VcsProjectConfigError>;
  }
>()("@shuv2code/vcs/VcsProjectConfig") {}

function configuredKind(config: ProjectVcsConfigFile): VcsDriverKindType | "auto" {
  return config.vcs?.kind ?? config.vcsKind ?? "auto";
}

const logVcsProjectConfigError = (error: VcsProjectConfigError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      cwd: error.cwd,
      configPath: error.configPath,
      errorTag: error._tag,
    }),
  );

function parseGitDirPointer(contents: string): string | null {
  const pointer = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim();
  return pointer && pointer.length > 0 ? pointer : null;
}

function workspaceRootFromJjRepoPath(repoPath: string, path: Path.Path): string | null {
  const jjDirectory = path.dirname(repoPath);
  if (path.basename(repoPath) !== "repo" || path.basename(jjDirectory) !== ".jj") {
    return null;
  }
  return path.dirname(jjDirectory);
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const resolvePointerTarget = Effect.fn("VcsProjectConfig.resolvePointerTarget")(function* (
    pointerPath: string,
    pointer: string,
  ) {
    const target = path.isAbsolute(pointer)
      ? path.normalize(pointer)
      : path.resolve(path.dirname(pointerPath), pointer);
    return yield* fileSystem.realPath(target).pipe(Effect.option);
  });

  const resolveJjProjectRoot = Effect.fn("VcsProjectConfig.resolveJjProjectRoot")(function* (
    workspaceRoot: string,
  ) {
    const repoEntry = path.join(workspaceRoot, ".jj", "repo");
    const info = yield* fileSystem.stat(repoEntry).pipe(Effect.option);
    if (Option.isNone(info)) {
      return Option.none<string>();
    }
    if (info.value.type === "Directory") {
      return Option.some(workspaceRoot);
    }
    if (info.value.type !== "File") {
      return Option.none<string>();
    }

    const contents = yield* fileSystem.readFileString(repoEntry).pipe(Effect.option);
    if (Option.isNone(contents) || contents.value.trim().length === 0) {
      return Option.none<string>();
    }
    const target = yield* resolvePointerTarget(repoEntry, contents.value.trim());
    return Option.flatMap(target, (repoPath) =>
      Option.fromNullishOr(workspaceRootFromJjRepoPath(repoPath, path)),
    );
  });

  const resolveGitProjectRoot = Effect.fn("VcsProjectConfig.resolveGitProjectRoot")(function* (
    workspaceRoot: string,
  ) {
    const gitEntry = path.join(workspaceRoot, ".git");
    const info = yield* fileSystem.stat(gitEntry).pipe(Effect.option);
    if (Option.isNone(info)) {
      return Option.none<string>();
    }
    if (info.value.type === "Directory") {
      return Option.some(workspaceRoot);
    }
    if (info.value.type !== "File") {
      return Option.none<string>();
    }

    const contents = yield* fileSystem.readFileString(gitEntry).pipe(Effect.option);
    if (Option.isNone(contents)) {
      return Option.none<string>();
    }
    const gitDirPointer = parseGitDirPointer(contents.value);
    if (gitDirPointer === null) {
      return Option.none<string>();
    }
    const gitDir = yield* resolvePointerTarget(gitEntry, gitDirPointer);
    if (Option.isNone(gitDir)) {
      return Option.none<string>();
    }

    const commonDirPointerPath = path.join(gitDir.value, "commondir");
    const commonDirContents = yield* fileSystem
      .readFileString(commonDirPointerPath)
      .pipe(Effect.option);
    if (Option.isNone(commonDirContents) || commonDirContents.value.trim().length === 0) {
      // A .git file without commondir is a primary checkout with a separate
      // Git directory or a submodule, not a standard linked worktree.
      return Option.some(workspaceRoot);
    }
    const commonDir = yield* resolvePointerTarget(
      commonDirPointerPath,
      commonDirContents.value.trim(),
    );
    if (Option.isNone(commonDir) || path.basename(commonDir.value) !== ".git") {
      return Option.some(workspaceRoot);
    }

    const primaryRoot = path.dirname(commonDir.value);
    const primaryGitDir = yield* fileSystem
      .realPath(path.join(primaryRoot, ".git"))
      .pipe(Effect.option);
    return Option.isSome(primaryGitDir) && primaryGitDir.value === commonDir.value
      ? Option.some(primaryRoot)
      : Option.some(workspaceRoot);
  });

  const resolveProjectRoot = Effect.fn("VcsProjectConfig.resolveProjectRoot")(function* (
    cwd: string,
  ) {
    let current = yield* fileSystem
      .realPath(cwd)
      .pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
    while (true) {
      const jjRoot = yield* resolveJjProjectRoot(current);
      if (Option.isSome(jjRoot)) {
        return jjRoot;
      }
      const gitRoot = yield* resolveGitProjectRoot(current);
      if (Option.isSome(gitRoot)) {
        return gitRoot;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return Option.none<string>();
      }
      current = parent;
    }
  });

  const inspectConfigPath = Effect.fn("VcsProjectConfig.inspectConfigPath")(function* (
    directory: string,
    cwd: string,
  ) {
    const candidate = path.join(directory, ".shuv2code", "vcs.json");
    const exists = yield* fileSystem.exists(candidate).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProjectConfigError({
            operation: "inspect",
            cwd,
            configPath: candidate,
            cause,
          }),
      ),
      Effect.catchTags({
        VcsProjectConfigError: (error) => logVcsProjectConfigError(error).pipe(Effect.as(false)),
      }),
    );
    return exists ? Option.some(candidate) : Option.none<string>();
  });

  const findConfigPath = Effect.fn("VcsProjectConfig.findConfigPath")(function* (
    searchStart: string,
    cwd: string,
  ) {
    let current = searchStart;
    while (true) {
      const configPath = yield* inspectConfigPath(current, cwd);
      if (Option.isSome(configPath)) {
        return configPath;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return Option.none();
      }
      current = parent;
    }
  });

  const readConfiguredKind = Effect.fn("VcsProjectConfig.readConfiguredKind")(function* (
    cwd: string,
    configPath: string,
  ) {
    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProjectConfigError({
            operation: "read",
            cwd,
            configPath,
            cause,
          }),
      ),
    );
    const parsed = yield* decodeProjectVcsConfigJson(raw).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProjectConfigError({
            operation: "decode",
            cwd,
            configPath,
            cause,
          }),
      ),
    );
    return configuredKind(parsed);
  });

  const resolveKind: VcsProjectConfig["Service"]["resolveKind"] = Effect.fn(
    "VcsProjectConfig.resolveKind",
  )(function* (input) {
    if (input.requestedKind !== undefined && input.requestedKind !== "auto") {
      return input.requestedKind;
    }

    const projectRoot = yield* resolveProjectRoot(input.cwd);
    const configPath = Option.isSome(projectRoot)
      ? yield* inspectConfigPath(projectRoot.value, input.cwd)
      : yield* findConfigPath(input.cwd, input.cwd);
    return yield* Effect.succeed(configPath).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed("auto" as const),
          onSome: (configPath) => readConfiguredKind(input.cwd, configPath),
        }),
      ),
      Effect.catchTags({
        VcsProjectConfigError: (error) =>
          logVcsProjectConfigError(error).pipe(Effect.as("auto" as const)),
      }),
    );
  });

  const setKind: VcsProjectConfig["Service"]["setKind"] = Effect.fn("VcsProjectConfig.setKind")(
    function* (input) {
      const projectRoot = yield* resolveProjectRoot(input.cwd);
      const configRoot = Option.getOrElse(projectRoot, () => input.cwd);
      const configDir = path.join(configRoot, ".shuv2code");
      const configPath = path.join(configDir, "vcs.json");
      const contents = yield* encodeProjectVcsConfigJson(
        input.kind === null ? {} : { vcs: { kind: input.kind } },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProjectConfigError({
              operation: "encode",
              cwd: input.cwd,
              configPath,
              cause,
            }),
        ),
      );
      yield* fileSystem.makeDirectory(configDir, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProjectConfigError({
              operation: "prepare",
              cwd: input.cwd,
              configPath,
              cause,
            }),
        ),
      );
      yield* writeFileStringAtomically({ filePath: configPath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new VcsProjectConfigError({
              operation: "write",
              cwd: input.cwd,
              configPath,
              cause,
            }),
        ),
      );
    },
  );

  return VcsProjectConfig.of({
    resolveKind,
    setKind,
  });
});

export const layer = Layer.effect(VcsProjectConfig, make);
