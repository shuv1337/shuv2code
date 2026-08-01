import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";

import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import { resolveVoiceControlPolicy, ServerSettingsService } from "../../serverSettings.ts";
import { codexAppServerSupervisorKey, codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  CodexAppServerSupervisor,
  type CodexAppServerConnection,
  type CodexAppServerSupervisorKey,
  type CodexAppServerSupervisorShape,
} from "../Services/CodexAppServerSupervisor.ts";

const CODEX_APP_SERVER_FORCE_KILL_AFTER = "5 seconds" as const;
const SOCKET_READY_ATTEMPTS = 50;
const SOCKET_READY_INTERVAL = "50 millis" as const;
const RESTART_BACKOFF_BASE_MS = 500;
const RESTART_BACKOFF_MAX_MS = 5_000;

interface SupervisedProcess {
  readonly digest: string;
  readonly socketDir: string;
  readonly socketPath: string;
  readonly lockPath: string;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly childScope: Scope.Closeable;
  readonly refCount: number;
}

interface SupervisedCrashState {
  readonly consecutiveFailures: number;
  readonly lastExitAtMs: number;
}

const hashKey = (material: string): string =>
  NodeCrypto.createHash("sha256").update(material).digest("hex").slice(0, 24);

const spawnError = (binaryPath: string, cause: unknown) =>
  new CodexErrors.CodexAppServerSpawnError({
    command: `${binaryPath} app-server`,
    cause,
  });

/** Restart delay after `consecutiveFailures` crashes, bounded. */
export const restartBackoffMs = (consecutiveFailures: number): number =>
  consecutiveFailures <= 0
    ? 0
    : Math.min(RESTART_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), RESTART_BACKOFF_MAX_MS);

/**
 * Default connection factory: WebSocket frames over the process's private
 * Unix control socket, with per-connection termination observation.
 */
const connectUnixSocket = (
  socketPath: string,
): Effect.Effect<CodexAppServerConnection, CodexErrors.CodexAppServerError, Scope.Scope> =>
  Effect.gen(function* () {
    const terminated = yield* Deferred.make<CodexErrors.CodexAppServerError>();
    const clientContext = yield* CodexClient.layerUnixSocket(socketPath, {
      onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
    }).pipe(Layer.build);
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );
    return {
      client,
      terminated: Deferred.await(terminated),
    } satisfies CodexAppServerConnection;
  });

export interface MakeCodexAppServerSupervisorOptions {
  /** Test seam: connection factory used once the control socket is ready. */
  readonly connect?: (
    socketPath: string,
  ) => Effect.Effect<CodexAppServerConnection, CodexErrors.CodexAppServerError, Scope.Scope>;
}

export const makeCodexAppServerSupervisor = Effect.fn("CodexAppServerSupervisor.make")(function* (
  options: MakeCodexAppServerSupervisorOptions = {},
) {
  const settings = yield* ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  // Layer construction scope: supervised children outlive any single session
  // and die only when the supervisor itself is torn down.
  const supervisorScope = yield* Scope.Scope;
  const topologySetting = yield* settings.getSettings.pipe(
    Effect.map((s) => s.codexAppServerTopology),
    Effect.orElseSucceed(() => "per-session" as const),
  );
  // Decide realtime enablement once per supervised process from voice policy.
  // Session-conditional flags must never split the key for one Codex home.
  const sharedRealtimeEnabled =
    topologySetting === "shared" ? yield* resolveSharedRealtimeEnablement() : false;
  const processesRef = yield* Ref.make(new Map<string, SupervisedProcess>());
  const crashesRef = yield* Ref.make(new Map<string, SupervisedCrashState>());
  const acquireLane = yield* Semaphore.make(1);
  const connect = options.connect ?? connectUnixSocket;

  const recordCrash = (digest: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) =>
        Ref.update(crashesRef, (map) => {
          const next = new Map(map);
          next.set(digest, {
            consecutiveFailures: (map.get(digest)?.consecutiveFailures ?? 0) + 1,
            lastExitAtMs: nowMs,
          });
          return next;
        }),
      ),
    );

  const clearCrashState = (digest: string) =>
    Ref.update(crashesRef, (map) => {
      if (!map.has(digest)) return map;
      const next = new Map(map);
      next.delete(digest);
      return next;
    });

  const removeSocketState = (supervised: SupervisedProcess) =>
    fs
      .remove(supervised.socketPath)
      .pipe(Effect.ignore, Effect.andThen(fs.remove(supervised.lockPath).pipe(Effect.ignore)));

  const handleProcessExit = (
    digest: string,
    child: ChildProcessSpawner.ChildProcessHandle,
    exitCode: number | undefined,
  ) =>
    Effect.gen(function* () {
      const current = (yield* Ref.get(processesRef)).get(digest);
      if (current === undefined || current.child !== child) {
        return;
      }
      yield* Ref.update(processesRef, (map) => {
        const next = new Map(map);
        next.delete(digest);
        return next;
      });
      yield* recordCrash(digest);
      yield* Scope.close(current.childScope, Exit.void).pipe(Effect.ignore);
      yield* removeSocketState(current);
      yield* Effect.logWarning("shared codex app-server process exited", {
        digest,
        exitCode: exitCode ?? "unknown",
      });
    });

  const ensureProcess = (keyInput: CodexAppServerSupervisorKey, digest: string) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(processesRef)).get(digest);
      if (existing !== undefined) {
        yield* Ref.update(processesRef, (map) => {
          const current = map.get(digest);
          if (!current) return map;
          const next = new Map(map);
          next.set(digest, { ...current, refCount: current.refCount + 1 });
          return next;
        });
        return existing;
      }

      const crash = (yield* Ref.get(crashesRef)).get(digest);
      if (crash !== undefined) {
        const delayMs = restartBackoffMs(crash.consecutiveFailures);
        const remainingMs = delayMs - ((yield* Clock.currentTimeMillis) - crash.lastExitAtMs);
        if (remainingMs > 0) {
          yield* Effect.sleep(Duration.millis(remainingMs));
        }
      }

      // Short segment ("cas" + 16-hex digest) keeps the absolute socket path
      // under the unix socket path limit even for deep worktree state dirs.
      const socketDir = pathService.join(keyInput.runtimeDir, "cas", digest.slice(0, 16));
      const socketPath = pathService.join(socketDir, "control.sock");
      const lockPath = pathService.join(socketDir, "owner.lock");

      yield* fs
        .makeDirectory(socketDir, { recursive: true })
        .pipe(Effect.mapError((cause) => spawnError(keyInput.binaryPath, cause)));
      yield* fs.remove(socketPath).pipe(Effect.ignore);

      const args = codexSessionAppServerArgs(undefined, keyInput.launchArgs, {
        listenUnixPath: socketPath,
        enableRealtimeConversation: sharedRealtimeEnabled,
      });
      const env = {
        ...(keyInput.environment ?? process.env),
        ...(keyInput.codexHome === "" ? {} : { CODEX_HOME: keyInput.codexHome }),
      };
      const childScope = yield* Scope.make();
      const child = yield* spawner
        .spawn(
          ChildProcess.make(keyInput.binaryPath, args, {
            cwd: keyInput.cwd,
            env,
            extendEnv: false,
            forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, childScope),
          Effect.mapError((cause) => spawnError(keyInput.binaryPath, cause)),
          Effect.tapError(() => Scope.close(childScope, Exit.void).pipe(Effect.ignore)),
        );
      yield* fs.writeFileString(lockPath, String(child.pid ?? "unknown")).pipe(Effect.ignore);

      let ready = false;
      for (let attempt = 0; attempt < SOCKET_READY_ATTEMPTS; attempt++) {
        ready = yield* fs.exists(socketPath).pipe(Effect.orElseSucceed(() => false));
        if (ready) break;
        yield* Effect.sleep(SOCKET_READY_INTERVAL);
      }
      if (!ready) {
        yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
        yield* recordCrash(digest);
        return yield* spawnError(
          keyInput.binaryPath,
          new Error("control socket was not created before readiness timeout"),
        );
      }

      yield* clearCrashState(digest);
      const supervised: SupervisedProcess = {
        digest,
        socketDir,
        socketPath,
        lockPath,
        child,
        childScope,
        refCount: 1,
      };
      yield* Ref.update(processesRef, (map) => {
        const next = new Map(map);
        next.set(digest, supervised);
        return next;
      });

      yield* child.exitCode.pipe(
        Effect.map((exitCode): number | undefined => exitCode),
        Effect.orElseSucceed((): number | undefined => undefined),
        Effect.flatMap((exitCode) => handleProcessExit(digest, child, exitCode)),
        Effect.forkIn(supervisorScope),
      );

      return supervised;
    });

  const releaseConnection = (digest: string) =>
    Ref.update(processesRef, (map) => {
      const current = map.get(digest);
      if (!current) return map;
      const next = new Map(map);
      // Keep the process registered at refCount 0: the supervised child stays
      // the single owner of its Codex home until supervisor teardown, so a
      // later session reuses it instead of spawning a competing owner.
      next.set(digest, { ...current, refCount: Math.max(0, current.refCount - 1) });
      return next;
    });

  const acquireShared: CodexAppServerSupervisorShape["acquireConnection"] = (keyInput) =>
    Effect.gen(function* () {
      const material = codexAppServerSupervisorKey({
        binaryPath: keyInput.binaryPath,
        codexHome: keyInput.codexHome,
        launchArgs: keyInput.launchArgs,
        enableRealtimeConversation: sharedRealtimeEnabled,
      });
      const digest = hashKey(material);
      const supervised = yield* acquireLane.withPermits(1)(ensureProcess(keyInput, digest));
      yield* Effect.addFinalizer(() => releaseConnection(digest));
      return yield* connect(supervised.socketPath);
    });

  // Final shutdown: kill supervised children and remove only owned
  // socket/lock state.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const processes = yield* Ref.getAndSet(processesRef, new Map());
      for (const supervised of processes.values()) {
        yield* Scope.close(supervised.childScope, Exit.void).pipe(Effect.ignore);
        yield* removeSocketState(supervised);
      }
    }),
  );

  return CodexAppServerSupervisor.of({
    topology: topologySetting,
    sharedRealtimeEnabled,
    acquireConnection: (key) =>
      topologySetting === "shared"
        ? acquireShared(key)
        : Effect.fail(
            new CodexErrors.CodexAppServerSpawnError({
              command: "codex app-server",
              cause: new Error(
                "Shared topology is disabled; use per-session spawn in CodexSessionRuntime.",
              ),
            }),
          ),
  });
});

export const CodexAppServerSupervisorLive = Layer.effect(
  CodexAppServerSupervisor,
  makeCodexAppServerSupervisor(),
);

/** Test helper: topology fixed without settings service. */
export const layerTest = (topology: "per-session" | "shared" = "per-session") =>
  Layer.succeed(
    CodexAppServerSupervisor,
    CodexAppServerSupervisor.of({
      topology,
      sharedRealtimeEnabled: false,
      acquireConnection: () =>
        Effect.fail(
          new CodexErrors.CodexAppServerSpawnError({
            command: "codex app-server",
            cause: new Error("test supervisor does not spawn"),
          }),
        ),
    }),
  );

export const resolveSharedRealtimeEnablement = Effect.fn(
  "CodexAppServerSupervisor.resolveSharedRealtimeEnablement",
)(function* () {
  const settings = yield* ServerSettingsService;
  const policy = yield* settings.getSettings.pipe(
    Effect.map(resolveVoiceControlPolicy),
    Effect.orElseSucceed(() => ({ realtime: false, read: false, control: false })),
  );
  return policy.realtime;
});
