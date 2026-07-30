import { TrimmedNonEmptyString } from "@shuv2code/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "./atomicWrite.ts";

export const LOCAL_DESKTOP_ATTACH_FILE_NAME = "local-desktop-attach.json";

export const PersistedLocalDesktopAttach = Schema.Struct({
  version: Schema.Literal(1),
  credential: TrimmedNonEmptyString,
});
export type PersistedLocalDesktopAttach = typeof PersistedLocalDesktopAttach.Type;

export class LocalDesktopAttachError extends Schema.TaggedErrorClass<LocalDesktopAttachError>()(
  "LocalDesktopAttachError",
  {
    operation: Schema.Literals(["persist", "read", "decode"]),
    statePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} local desktop attach credential at ${this.statePath}.`;
  }
}

const decodePersistedLocalDesktopAttach = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedLocalDesktopAttach),
);

const LOCAL_DESKTOP_ATTACH_CREDENTIAL_BYTES = 24;

export const readPersistedLocalDesktopAttach = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new LocalDesktopAttachError({
                  operation: "read",
                  statePath: path,
                  cause,
                }),
              ),
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<PersistedLocalDesktopAttach>();
    }

    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return Option.none<PersistedLocalDesktopAttach>();
    }

    return yield* decodePersistedLocalDesktopAttach(trimmed).pipe(
      Effect.map(Option.some),
      Effect.mapError(
        (cause) =>
          new LocalDesktopAttachError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.catchTags({
      LocalDesktopAttachError: (error) =>
        Effect.logWarning(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            statePath: error.statePath,
            cause: error,
          }),
          Effect.as(Option.none<PersistedLocalDesktopAttach>()),
        ),
    }),
  );

export const persistLocalDesktopAttach = (input: {
  readonly path: string;
  readonly state: PersistedLocalDesktopAttach;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.state)}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new LocalDesktopAttachError({
          operation: "persist",
          statePath: input.path,
          cause,
        }),
    ),
  );

export const ensureLocalDesktopAttachCredential = Effect.fn("ensureLocalDesktopAttachCredential")(
  function* (
    path: string,
  ): Effect.fn.Return<
    string,
    LocalDesktopAttachError,
    FileSystem.FileSystem | Crypto.Crypto | Path.Path
  > {
    const existing = yield* readPersistedLocalDesktopAttach(path);
    if (Option.isSome(existing)) {
      return existing.value.credential;
    }

    const crypto = yield* Crypto.Crypto;
    const bytes = yield* crypto.randomBytes(LOCAL_DESKTOP_ATTACH_CREDENTIAL_BYTES).pipe(
      Effect.mapError(
        (cause) =>
          new LocalDesktopAttachError({
            operation: "persist",
            statePath: path,
            cause,
          }),
      ),
    );
    const credential = Encoding.encodeHex(bytes);
    yield* persistLocalDesktopAttach({
      path,
      state: { version: 1, credential },
    });
    return credential;
  },
);
