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

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const findConfigPath = Effect.fn("VcsProjectConfig.findConfigPath")(function* (cwd: string) {
    let current = cwd;
    while (true) {
      const candidate = path.join(current, ".shuv2code", "vcs.json");
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
      if (exists) {
        return Option.some(candidate);
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

    return yield* findConfigPath(input.cwd).pipe(
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
      const configDir = path.join(input.cwd, ".shuv2code");
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
