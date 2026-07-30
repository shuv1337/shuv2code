// @effect-diagnostics-next-line nodeBuiltinImport:off - Integration fixture needs a real ephemeral Node HTTP listener.
import * as NodeHttp from "node:http";

import { assert, describe, it } from "@effect/vitest";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLocalServerAttach from "./DesktopLocalServerAttach.ts";

const encodeRuntimeState = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      pid: Schema.Int,
      host: Schema.String,
      port: Schema.Int,
      origin: Schema.String,
      startedAt: Schema.String,
    }),
  ),
);
const encodeAttachCredential = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      credential: Schema.String,
    }),
  ),
);

const listenReadyServer = Effect.callback<{
  readonly origin: string;
  readonly port: number;
  readonly close: () => void;
}>((resume) => {
  const server = NodeHttp.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "env",
        displayName: "test",
        platform: "linux",
        architecture: "x64",
      }),
    );
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      resume(Effect.die("expected tcp address"));
      return;
    }
    resume(
      Effect.succeed({
        origin: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close: () => {
          server.close();
        },
      }),
    );
  });
});

describe("discoverReusableLocalServer", () => {
  it.effect("returns none when no attach credential exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "shuv2code-desktop-local-attach-test-",
      });
      const stateDir = path.join(root, "userdata");
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      const environment = {
        path,
        stateDir,
        configuredBackendPort: Option.none<number>(),
        baseDir: root,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];

      const discovered = yield* DesktopLocalServerAttach.discoverReusableLocalServer().pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      );
      assert.isTrue(Option.isNone(discovered));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici))),
  );

  it.effect("attaches when runtime origin is healthy and credential exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "shuv2code-desktop-local-attach-ready-",
      });
      const stateDir = path.join(root, "userdata");
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      const ready = yield* listenReadyServer;
      yield* Effect.addFinalizer(() => Effect.sync(ready.close));

      yield* fileSystem.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `${encodeRuntimeState({
          version: 1,
          pid: process.pid,
          host: "127.0.0.1",
          port: ready.port,
          origin: ready.origin,
          startedAt: "2026-07-29T00:00:00.000Z",
        })}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(stateDir, "local-desktop-attach.json"),
        `${encodeAttachCredential({ version: 1, credential: "attach-credential" })}\n`,
      );

      const environment = {
        path,
        stateDir,
        configuredBackendPort: Option.some(ready.port),
        baseDir: root,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];

      const discovered = yield* DesktopLocalServerAttach.discoverReusableLocalServer().pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      );

      assert.isTrue(Option.isSome(discovered));
      assert.strictEqual(Option.getOrThrow(discovered).bootstrapToken, "attach-credential");
      assert.strictEqual(Option.getOrThrow(discovered).port, ready.port);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
    ),
  );
});
