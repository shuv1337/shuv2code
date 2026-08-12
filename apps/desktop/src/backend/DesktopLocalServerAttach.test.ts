// @effect-diagnostics-next-line nodeBuiltinImport:off - Integration fixture needs a real ephemeral Node HTTP listener.
import * as NodeHttp from "node:http";

import { assert, describe, it } from "@effect/vitest";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLocalServerAttach from "./DesktopLocalServerAttach.ts";

const unavailableHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
  ),
);

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

const listenReadyServer = (
  delayMs = 0,
): Effect.Effect<{
  readonly origin: string;
  readonly port: number;
  readonly close: () => void;
}> =>
  Effect.callback((resume) => {
    const server = NodeHttp.createServer((_req, res) => {
      // @effect-diagnostics-next-line globalTimers:off - Real HTTP fixture needs wall-clock response ordering.
      const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "env",
            displayName: "test",
            platform: "linux",
            architecture: "x64",
          }),
        );
      }, delayMs);
      res.once("close", () => clearTimeout(timer));
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

const listenApiOnlyServer = Effect.callback<{
  readonly origin: string;
  readonly port: number;
  readonly close: () => void;
}>((resume) => {
  const server = NodeHttp.createServer((req, res) => {
    if (req.url === "/.well-known/shuv2code/environment") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "env" }));
      return;
    }
    if (req.url === "/") {
      res.writeHead(302, { location: "/unavailable-renderer" });
      res.end();
      return;
    }
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("renderer unavailable");
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

  it.effect("bounds discovery while reading persisted state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "shuv2code-desktop-local-attach-read-bound-",
      });
      const stateDir = path.join(root, "userdata");
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      const environment = {
        path,
        stateDir,
        configuredBackendPort: Option.none<number>(),
        baseDir: root,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];
      const stalledFileSystem = {
        ...fileSystem,
        readFileString: (filePath: string) =>
          filePath.endsWith("local-desktop-attach.json")
            ? Effect.never
            : fileSystem.readFileString(filePath),
      } as typeof fileSystem;

      const discovery = DesktopLocalServerAttach.discoverReusableLocalServer().pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
        Effect.provideService(FileSystem.FileSystem, stalledFileSystem),
      );
      const fiber = yield* Effect.forkChild(discovery);
      yield* TestClock.adjust(500);
      const discovered = yield* Fiber.join(fiber);

      assert.isTrue(Option.isNone(discovered));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, unavailableHttpClientLayer)),
    ),
  );

  it.effect("starts distinct candidate probes concurrently", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "shuv2code-desktop-local-attach-concurrent-",
      });
      const userdataDir = path.join(root, "userdata");
      const devDir = path.join(root, "dev");
      yield* fileSystem.makeDirectory(userdataDir, { recursive: true });
      yield* fileSystem.makeDirectory(devDir, { recursive: true });
      const secondaryObserved = yield* Deferred.make<void>();
      const preferredOrigin = "http://preferred.test:4101";
      const secondaryOrigin = "http://secondary.test:4102";
      for (const [stateDir, credential, origin, port] of [
        [userdataDir, "preferred-credential", preferredOrigin, 4101],
        [devDir, "secondary-credential", secondaryOrigin, 4102],
      ] as const) {
        yield* fileSystem.writeFileString(
          path.join(stateDir, "server-runtime.json"),
          `${encodeRuntimeState({
            version: 1,
            pid: process.pid,
            host: new URL(origin).hostname,
            port,
            origin,
            startedAt: "2026-08-12T00:00:00.000Z",
          })}\n`,
        );
        yield* fileSystem.writeFileString(
          path.join(stateDir, "local-desktop-attach.json"),
          `${encodeAttachCredential({ version: 1, credential })}\n`,
        );
      }
      const environment = {
        path,
        stateDir: userdataDir,
        configuredBackendPort: Option.none<number>(),
        baseDir: root,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];
      const httpClient = HttpClient.make((request) => {
        const url = new URL(request.url);
        if (url.origin === preferredOrigin) {
          return Deferred.await(secondaryObserved).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
          );
        }
        if (url.origin === secondaryOrigin) {
          return Deferred.succeed(secondaryObserved, undefined).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
        );
      });

      const discovered = yield* DesktopLocalServerAttach.discoverReusableLocalServer().pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );

      assert.isTrue(Option.isSome(discovered));
      assert.strictEqual(Option.getOrThrow(discovered).origin, preferredOrigin);
      assert.strictEqual(Option.getOrThrow(discovered).bootstrapToken, "preferred-credential");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds stale attach discovery across multiple state directories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "shuv2code-desktop-local-attach-stale-",
      });
      const stateDirs = [path.join(root, "userdata"), path.join(root, "dev")];
      for (const stateDir of stateDirs) {
        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(stateDir, "local-desktop-attach.json"),
          `${encodeAttachCredential({ version: 1, credential: `stale-${stateDir}` })}\n`,
        );
      }
      const environment = {
        path,
        stateDir: stateDirs[0]!,
        configuredBackendPort: Option.none<number>(),
        baseDir: root,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];

      const discovered = yield* DesktopLocalServerAttach.discoverReusableLocalServer().pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
        TestClock.withLive,
      );

      assert.isTrue(Option.isNone(discovered));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, unavailableHttpClientLayer)),
    ),
  );

  it.effect("preserves state-directory credential precedence for duplicate origins", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "shuv2code-desktop-local-attach-precedence-",
      });
      const userdataDir = path.join(root, "userdata");
      const devDir = path.join(root, "dev");
      yield* fileSystem.makeDirectory(userdataDir, { recursive: true });
      yield* fileSystem.makeDirectory(devDir, { recursive: true });
      const ready = yield* listenReadyServer();
      yield* Effect.addFinalizer(() => Effect.sync(ready.close));

      for (const [stateDir, credential] of [
        [userdataDir, "userdata-credential"],
        [devDir, "dev-credential"],
      ] as const) {
        yield* fileSystem.writeFileString(
          path.join(stateDir, "local-desktop-attach.json"),
          `${encodeAttachCredential({ version: 1, credential })}\n`,
        );
      }
      const environment = {
        path,
        stateDir: userdataDir,
        configuredBackendPort: Option.some(ready.port),
        baseDir: root,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];

      const discovered = yield* DesktopLocalServerAttach.discoverReusableLocalServer().pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      );

      assert.isTrue(Option.isSome(discovered));
      assert.strictEqual(Option.getOrThrow(discovered).bootstrapToken, "userdata-credential");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
    ),
  );

  it.effect("keeps candidate precedence when multiple distinct origins are healthy", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "shuv2code-desktop-local-attach-distinct-precedence-",
      });
      const userdataDir = path.join(root, "userdata");
      const devDir = path.join(root, "dev");
      yield* fileSystem.makeDirectory(userdataDir, { recursive: true });
      yield* fileSystem.makeDirectory(devDir, { recursive: true });
      const preferred = yield* listenReadyServer(75);
      const secondary = yield* listenReadyServer();
      yield* Effect.addFinalizer(() => Effect.sync(preferred.close));
      yield* Effect.addFinalizer(() => Effect.sync(secondary.close));

      for (const [stateDir, credential, server] of [
        [userdataDir, "userdata-credential", preferred],
        [devDir, "dev-credential", secondary],
      ] as const) {
        yield* fileSystem.writeFileString(
          path.join(stateDir, "server-runtime.json"),
          `${encodeRuntimeState({
            version: 1,
            pid: process.pid,
            host: "127.0.0.1",
            port: server.port,
            origin: server.origin,
            startedAt: "2026-08-12T00:00:00.000Z",
          })}\n`,
        );
        yield* fileSystem.writeFileString(
          path.join(stateDir, "local-desktop-attach.json"),
          `${encodeAttachCredential({ version: 1, credential })}\n`,
        );
      }
      const environment = {
        path,
        stateDir: userdataDir,
        configuredBackendPort: Option.none<number>(),
        baseDir: root,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];

      const discovered = yield* DesktopLocalServerAttach.discoverReusableLocalServer().pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      );

      assert.isTrue(Option.isSome(discovered));
      assert.strictEqual(Option.getOrThrow(discovered).origin, preferred.origin);
      assert.strictEqual(Option.getOrThrow(discovered).bootstrapToken, "userdata-credential");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
    ),
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
      const ready = yield* listenReadyServer();
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

  it.effect("rejects a healthy API when its renderer is unavailable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "shuv2code-desktop-local-attach-renderer-unavailable-",
      });
      const stateDir = path.join(root, "userdata");
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      const ready = yield* listenApiOnlyServer;
      yield* Effect.addFinalizer(() => Effect.sync(ready.close));

      yield* fileSystem.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `${encodeRuntimeState({
          version: 1,
          pid: process.pid,
          host: "127.0.0.1",
          port: ready.port,
          origin: ready.origin,
          startedAt: "2026-08-02T00:00:00.000Z",
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
        TestClock.withLive,
      );

      assert.isTrue(Option.isNone(discovered));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
    ),
  );
});
