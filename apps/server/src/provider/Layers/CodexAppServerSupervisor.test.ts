import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { CodexAppServerClient } from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  codexAppServerSupervisorKey,
  codexSessionAppServerArgs,
  stripCodexListenArgs,
} from "./codexLaunchArgs.ts";
import {
  layerTest,
  makeCodexAppServerSupervisor,
  restartBackoffMs,
} from "./CodexAppServerSupervisor.ts";
import {
  CodexAppServerSupervisor,
  type CodexAppServerConnection,
} from "../Services/CodexAppServerSupervisor.ts";

interface FakeSpawn {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly socketPath: string | undefined;
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  readonly kills: Ref.Ref<number>;
}

interface FakeSpawnerState {
  readonly spawns: Array<FakeSpawn>;
}

/**
 * Fake app-server child: records the launch identity, "creates" the control
 * socket before returning so readiness polling succeeds, and exposes a
 * deferred exit code so tests can crash the process on demand.
 */
const fakeSpawnerLayer = (state: FakeSpawnerState) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const cmd = command as unknown as {
            readonly command: string;
            readonly args: ReadonlyArray<string>;
            readonly options?: { readonly env?: NodeJS.ProcessEnv };
          };
          const listenIndex = cmd.args.indexOf("--listen");
          const listenTarget = listenIndex >= 0 ? cmd.args[listenIndex + 1] : undefined;
          const socketPath = listenTarget?.startsWith("unix://")
            ? listenTarget.slice("unix://".length)
            : undefined;
          const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const kills = yield* Ref.make(0);
          state.spawns.push({
            args: cmd.args,
            env: cmd.options?.env,
            socketPath,
            exit,
            kills,
          });
          if (socketPath !== undefined) {
            yield* fs.writeFileString(socketPath, "");
          }
          const handle = ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1000 + state.spawns.length),
            exitCode: Deferred.await(exit),
            isRunning: Effect.succeed(true),
            kill: () => Ref.update(kills, (current) => current + 1),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.never,
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
    }),
  );

const fakeConnect = (
  socketPath: string,
): Effect.Effect<CodexAppServerConnection, CodexErrors.CodexAppServerError, Scope.Scope> =>
  Effect.succeed({
    client: { socketPath } as unknown as CodexAppServerClient["Service"],
    terminated: Effect.never as Effect.Effect<CodexErrors.CodexAppServerError>,
  });

const makeRuntimeDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "shuv2code-cas-test-" });
});

const makeKey = (runtimeDir: string, codexHome: string) => ({
  binaryPath: "codex",
  codexHome,
  launchArgs: "",
  cwd: "/tmp",
  runtimeDir,
});

const sharedSupervisorHarness = Effect.fnUntraced(function* () {
  const supervisorScope = yield* Scope.make();
  const supervisor = yield* makeCodexAppServerSupervisor({ connect: fakeConnect }).pipe(
    Effect.provideService(Scope.Scope, supervisorScope),
  );
  return { supervisor, supervisorScope };
});

const testLayerWithTopology = (state: FakeSpawnerState, topology: "per-session" | "shared") =>
  fakeSpawnerLayer(state).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        ServerSettingsService.layerTest({ codexAppServerTopology: topology }),
      ),
    ),
  );

describe("CodexAppServerSupervisor", () => {
  it.effect("exposes per-session topology by default in the test layer", () =>
    Effect.gen(function* () {
      const supervisor = yield* CodexAppServerSupervisor;
      NodeAssert.equal(supervisor.topology, "per-session");
    }).pipe(Effect.provide(layerTest("per-session"))),
  );

  it("keeps shared launch args deterministic", () => {
    const args = codexSessionAppServerArgs(["--config", "foo=1"], "--listen off", {
      listenUnixPath: "/var/run/shuv2code/a.sock",
      enableRealtimeConversation: true,
    });
    NodeAssert.ok(args.includes("unix:///var/run/shuv2code/a.sock"));
    NodeAssert.ok(!args.includes("off"));
    NodeAssert.deepStrictEqual(stripCodexListenArgs(["--listen", "ws://x", "a"]), ["a"]);
    NodeAssert.ok(
      codexAppServerSupervisorKey({
        binaryPath: "codex",
        codexHome: "/h",
        launchArgs: "",
        enableRealtimeConversation: true,
      }).includes("realtime"),
    );
  });

  it("bounds restart backoff", () => {
    NodeAssert.equal(restartBackoffMs(0), 0);
    NodeAssert.equal(restartBackoffMs(1), 500);
    NodeAssert.equal(restartBackoffMs(2), 1000);
    NodeAssert.equal(restartBackoffMs(20), 5000);
  });

  it.effect("shared topology test layer fails closed without a real spawn", () =>
    Effect.gen(function* () {
      const supervisor = yield* CodexAppServerSupervisor;
      NodeAssert.equal(supervisor.topology, "shared");
      const error = yield* Effect.flip(
        supervisor.acquireConnection({
          binaryPath: "codex",
          codexHome: "/tmp/codex-home",
          launchArgs: "",
          cwd: "/tmp",
          runtimeDir: "/tmp/shuv2code-runtime",
        }),
      );
      NodeAssert.equal(error._tag, "CodexAppServerSpawnError");
    }).pipe(Effect.provide(layerTest("shared"))),
  );

  it.effect("per-session live supervisor refuses shared acquisition", () => {
    const state: FakeSpawnerState = { spawns: [] };
    return Effect.gen(function* () {
      const runtimeDir = yield* makeRuntimeDir;
      const { supervisor, supervisorScope } = yield* sharedSupervisorHarness();
      const error = yield* Effect.flip(
        supervisor
          .acquireConnection(makeKey(runtimeDir, "/tmp/home"))
          .pipe(Scope.provide(supervisorScope)),
      );
      NodeAssert.equal(error._tag, "CodexAppServerSpawnError");
      NodeAssert.equal(state.spawns.length, 0);
      yield* Scope.close(supervisorScope, Exit.void);
    }).pipe(Effect.provide(testLayerWithTopology(state, "per-session")));
  });

  it.effect("shares one supervised process per key and separates processes per Codex home", () => {
    const state: FakeSpawnerState = { spawns: [] };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const runtimeDir = yield* makeRuntimeDir;
      const { supervisor, supervisorScope } = yield* sharedSupervisorHarness();
      NodeAssert.equal(supervisor.topology, "shared");

      const keyA = makeKey(runtimeDir, "/tmp/home-a");
      const connectionScopeA1 = yield* Scope.make();
      const connectionScopeA2 = yield* Scope.make();
      const first = yield* supervisor
        .acquireConnection(keyA)
        .pipe(Scope.provide(connectionScopeA1));
      const second = yield* supervisor
        .acquireConnection(keyA)
        .pipe(Scope.provide(connectionScopeA2));
      NodeAssert.equal(state.spawns.length, 1);
      NodeAssert.deepStrictEqual(first.client, second.client);

      // Launch identity: private unix listen path inside the runtime dir
      // plus a process-level realtime decision from voice policy.
      const spawn = state.spawns[0]!;
      NodeAssert.ok(spawn.socketPath?.startsWith(pathService.join(runtimeDir, "cas")));
      NodeAssert.equal(spawn.env?.CODEX_HOME, "/tmp/home-a");
      NodeAssert.equal(
        spawn.args.includes("realtime_conversation"),
        supervisor.sharedRealtimeEnabled,
      );

      const connectionScopeB = yield* Scope.make();
      yield* supervisor
        .acquireConnection(makeKey(runtimeDir, "/tmp/home-b"))
        .pipe(Scope.provide(connectionScopeB));
      NodeAssert.equal(state.spawns.length, 2);

      // Releasing every connection keeps the owner process alive for reuse.
      yield* Scope.close(connectionScopeA1, Exit.void);
      yield* Scope.close(connectionScopeA2, Exit.void);
      const connectionScopeA3 = yield* Scope.make();
      yield* supervisor.acquireConnection(keyA).pipe(Scope.provide(connectionScopeA3));
      NodeAssert.equal(state.spawns.length, 2);
      NodeAssert.equal(yield* Ref.get(spawn.kills), 0);

      // Final shutdown kills owned processes and removes owned socket state.
      yield* Scope.close(supervisorScope, Exit.void);
      NodeAssert.ok((yield* Ref.get(spawn.kills)) > 0);
      NodeAssert.equal(yield* fs.exists(spawn.socketPath ?? ""), false);
    }).pipe(Effect.provide(testLayerWithTopology(state, "shared")));
  });

  it.effect("restarts a crashed supervised process once with bounded backoff", () => {
    const state: FakeSpawnerState = { spawns: [] };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeDir = yield* makeRuntimeDir;
      const { supervisor, supervisorScope } = yield* sharedSupervisorHarness();
      const key = makeKey(runtimeDir, "/tmp/home-crash");

      const connectionScope1 = yield* Scope.make();
      yield* supervisor.acquireConnection(key).pipe(Scope.provide(connectionScope1));
      NodeAssert.equal(state.spawns.length, 1);
      const firstSocketPath = state.spawns[0]!.socketPath ?? "";

      // Crash the shared process and let the exit monitor settle. The monitor
      // runs real FS cleanup, so wait on real async FS reads rather than
      // virtual TestClock time.
      yield* Deferred.succeed(state.spawns[0]!.exit, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust("1 millis");
      for (let attempt = 0; attempt < 1000 && (yield* fs.exists(firstSocketPath)); attempt++) {
        yield* Effect.yieldNow;
      }
      NodeAssert.equal(yield* fs.exists(firstSocketPath), false);

      // The next acquisition respawns exactly one replacement process after
      // the bounded backoff window.
      const connectionScope2 = yield* Scope.make();
      const fiber = yield* supervisor
        .acquireConnection(key)
        .pipe(Scope.provide(connectionScope2), Effect.forkChild);
      yield* TestClock.adjust("499 millis");
      NodeAssert.equal(state.spawns.length, 1);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      NodeAssert.equal(state.spawns.length, 2);

      yield* Scope.close(supervisorScope, Exit.void);
    }).pipe(Effect.provide(testLayerWithTopology(state, "shared")));
  });

  it.effect(
    "does not head-of-line block acquisitions for a different digest behind another digest's backoff",
    () => {
      const state: FakeSpawnerState = { spawns: [] };
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runtimeDir = yield* makeRuntimeDir;
        const { supervisor, supervisorScope } = yield* sharedSupervisorHarness();
        const keyA = makeKey(runtimeDir, "/tmp/home-a");
        const keyB = makeKey(runtimeDir, "/tmp/home-b");

        const connectionScopeA1 = yield* Scope.make();
        yield* supervisor.acquireConnection(keyA).pipe(Scope.provide(connectionScopeA1));
        NodeAssert.equal(state.spawns.length, 1);
        const firstSocketPath = state.spawns[0]!.socketPath ?? "";

        // Crash home-a's process and let the exit monitor settle, putting
        // digest A into its backoff window.
        yield* Deferred.succeed(state.spawns[0]!.exit, ChildProcessSpawner.ExitCode(1));
        yield* TestClock.adjust("1 millis");
        for (let attempt = 0; attempt < 1000 && (yield* fs.exists(firstSocketPath)); attempt++) {
          yield* Effect.yieldNow;
        }
        NodeAssert.equal(yield* fs.exists(firstSocketPath), false);

        // Start (but do not resolve) a re-acquisition of home-a: it must sit
        // in home-a's backoff window without ever completing in this test.
        const connectionScopeA2 = yield* Scope.make();
        const fiberA = yield* supervisor
          .acquireConnection(keyA)
          .pipe(Scope.provide(connectionScopeA2), Effect.forkChild);
        yield* Effect.yieldNow;
        NodeAssert.equal(state.spawns.length, 1);

        // A different digest (home-b) must spawn immediately: it must not
        // wait behind home-a's backoff, so no TestClock advance beyond
        // letting fibers settle is needed.
        const connectionScopeB = yield* Scope.make();
        yield* supervisor.acquireConnection(keyB).pipe(Scope.provide(connectionScopeB));
        NodeAssert.equal(state.spawns.length, 2);
        NodeAssert.equal(
          state.spawns[1]!.env?.CODEX_HOME,
          "/tmp/home-b",
          "second spawn is the unrelated home-b process, not a delayed home-a respawn",
        );

        // Let home-a's backoff finish so the forked fiber can be joined
        // cleanly during teardown.
        yield* TestClock.adjust("500 millis");
        yield* Fiber.join(fiberA);
        NodeAssert.equal(state.spawns.length, 3);

        yield* Scope.close(supervisorScope, Exit.void);
      }).pipe(Effect.provide(testLayerWithTopology(state, "shared")));
    },
  );

  it.effect("reviveCrashed respawns a crashed shared process without a caller", () => {
    const state: FakeSpawnerState = { spawns: [] };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeDir = yield* makeRuntimeDir;
      const { supervisor, supervisorScope } = yield* sharedSupervisorHarness();
      const key = makeKey(runtimeDir, "/tmp/home-revive");

      const connectionScope = yield* Scope.make();
      yield* supervisor.acquireConnection(key).pipe(Scope.provide(connectionScope));
      NodeAssert.equal((yield* supervisor.status).runningProcesses, 1);
      const firstSocketPath = state.spawns[0]!.socketPath ?? "";

      // Crash the shared process and let the exit monitor settle.
      yield* Deferred.succeed(state.spawns[0]!.exit, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust("1 millis");
      for (let attempt = 0; attempt < 1000 && (yield* fs.exists(firstSocketPath)); attempt++) {
        yield* Effect.yieldNow;
      }
      const crashed = yield* supervisor.status;
      NodeAssert.equal(crashed.runningProcesses, 0);
      NodeAssert.equal(crashed.crashed.length, 1);

      // No session ever re-acquires (the outage blocked them); the health
      // checker's revive respawns from the recorded key through the normal
      // ensureProcess path — including its bounded backoff window.
      const reviveFiber = yield* supervisor.reviveCrashed.pipe(Effect.forkChild);
      yield* TestClock.adjust("600 millis");
      yield* Fiber.join(reviveFiber);
      NodeAssert.equal(state.spawns.length, 2);
      const revived = yield* supervisor.status;
      NodeAssert.equal(revived.runningProcesses, 1);
      NodeAssert.equal(revived.crashed.length, 0);

      yield* Scope.close(supervisorScope, Exit.void);
    }).pipe(Effect.provide(testLayerWithTopology(state, "shared")));
  });

  it.effect("does not apply restart backoff after a clean exit-code-0 shutdown", () => {
    const state: FakeSpawnerState = { spawns: [] };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeDir = yield* makeRuntimeDir;
      const { supervisor, supervisorScope } = yield* sharedSupervisorHarness();
      const key = makeKey(runtimeDir, "/tmp/home-clean-exit");

      const connectionScope1 = yield* Scope.make();
      yield* supervisor.acquireConnection(key).pipe(Scope.provide(connectionScope1));
      NodeAssert.equal(state.spawns.length, 1);
      const firstSocketPath = state.spawns[0]!.socketPath ?? "";

      // Clean exit (code 0): must not be recorded as a crash.
      yield* Deferred.succeed(state.spawns[0]!.exit, ChildProcessSpawner.ExitCode(0));
      yield* TestClock.adjust("1 millis");
      for (let attempt = 0; attempt < 1000 && (yield* fs.exists(firstSocketPath)); attempt++) {
        yield* Effect.yieldNow;
      }
      NodeAssert.equal(yield* fs.exists(firstSocketPath), false);

      // The next acquisition respawns immediately, without waiting through
      // any backoff window (no TestClock advance needed).
      const connectionScope2 = yield* Scope.make();
      yield* supervisor.acquireConnection(key).pipe(Scope.provide(connectionScope2));
      NodeAssert.equal(state.spawns.length, 2);

      yield* Scope.close(supervisorScope, Exit.void);
    }).pipe(Effect.provide(testLayerWithTopology(state, "shared")));
  });
});
