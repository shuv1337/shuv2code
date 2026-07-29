import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const sha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

const makeCaptureLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const findIdentityLog = (
  logs: ReadonlyArray<CapturedLog>,
  source: Identify.TelemetryIdentitySource,
  errorTag: string,
) => logs.find((log) => log.annotations.source === source && log.annotations.errorTag === errorTag);

it("preserves exact telemetry identity causes without deriving messages from them", () => {
  const readCause = new Error("private nested read details");
  const readError = new Identify.TelemetryIdentityReadError({
    source: "anonymous",
    filePath: "/tmp/anonymous-id",
    cause: readCause,
  });
  const hashCause = new Error("private nested hash details");
  const hashError = new Identify.TelemetryIdentityHashError({
    source: "anonymous",
    algorithm: "SHA-256",
    cause: hashCause,
  });

  assert.strictEqual(readError.cause, readCause);
  assert.strictEqual(hashError.cause, hashCause);
  assert.notInclude(readError.message, readCause.message);
  assert.notInclude(hashError.message, hashCause.message);
});

it.layer(NodeServices.layer)("telemetry identity", (it) => {
  it.effect("uses the persisted anonymous id when provider identities are absent", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const anonymousId = "persisted-anonymous-id";

      yield* fileSystem.writeFileString(config.anonymousIdPath, anonymousId);

      const identifier = yield* Identify.getTelemetryIdentifier();

      assert.equal(identifier, sha256(anonymousId));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "shuv2code-telemetry-identify-anonymous-",
        }),
      ),
    ),
  );

  it.effect("generates, persists, and reuses an anonymous id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      const identifier = yield* Identify.getTelemetryIdentifier();
      const anonymousId = yield* fileSystem.readFileString(config.anonymousIdPath);
      const reusedIdentifier = yield* Identify.getTelemetryIdentifier();

      assert.equal(identifier, sha256(anonymousId));
      assert.equal(reusedIdentifier, identifier);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "shuv2code-telemetry-identify-generate-",
        }),
      ),
    ),
  );

  it.effect("does not overwrite the anonymous id path after a non-NotFound read failure", () => {
    const logs: CapturedLog[] = [];
    const logger = makeCaptureLogger(logs);

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      yield* fileSystem.makeDirectory(config.anonymousIdPath);

      const identifier = yield* Identify.getTelemetryIdentifier();

      assert.isNull(identifier);
      assert.deepEqual(yield* fileSystem.readDirectory(config.anonymousIdPath), []);

      const readLog = findIdentityLog(logs, "anonymous", "TelemetryIdentityReadError");
      assert.isDefined(readLog);
      assert.equal(readLog?.annotations.filePath, config.anonymousIdPath);
      assert.equal(readLog?.annotations.causeKind, "platform");
      assert.notEqual(readLog?.annotations.platformReason, "NotFound");
      assert.notProperty(readLog?.annotations ?? {}, "cause");
      const errorStack = readLog?.annotations.errorStack;
      assert.isString(errorStack);
      assert.include(errorStack, "Failed to read anonymous telemetry identity");
      assert.isUndefined(
        findIdentityLog(logs, "anonymous", "TelemetryAnonymousIdPersistenceError"),
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "shuv2code-telemetry-identify-read-",
          }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });
});
