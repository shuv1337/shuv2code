import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as crypto from "node:crypto";

import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import { resolveVoiceControlPolicy, ServerSettingsService } from "../../serverSettings.ts";
import { codexAppServerSupervisorKey, codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  CodexAppServerSupervisor,
  type CodexAppServerSupervisorShape,
} from "../Services/CodexAppServerSupervisor.ts";

const CODEX_APP_SERVER_FORCE_KILL_AFTER = "5 seconds" as const;

interface SupervisedProcess {
  readonly key: string;
  readonly socketPath: string;
  readonly lockPath: string;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly refCount: number;
}

const hashKey = (material: string): string =>
  crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);

export const makeCodexAppServerSupervisor = Effect.fn("CodexAppServerSupervisor.make")(
  function* () {
    const settings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const topologySetting = yield* settings.getSettings.pipe(
      Effect.map((s) => s.codexAppServerTopology),
      Effect.orElseSucceed(() => "per-session" as const),
    );
    const processesRef = yield* Ref.make(new Map<string, SupervisedProcess>());

    const acquireShared: CodexAppServerSupervisorShape["acquireConnection"] = (keyInput) =>
      Effect.gen(function* () {
        const material = codexAppServerSupervisorKey({
          binaryPath: keyInput.binaryPath,
          codexHome: keyInput.codexHome,
          launchArgs: keyInput.launchArgs,
          enableRealtimeConversation: keyInput.enableRealtimeConversation,
        });
        const digest = hashKey(material);
        const socketDir = pathService.join(keyInput.runtimeDir, "codex-app-server", digest);
        const socketPath = pathService.join(socketDir, "control.sock");
        const lockPath = pathService.join(socketDir, "owner.lock");

        yield* fs.makeDirectory(socketDir, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new CodexErrors.CodexAppServerSpawnError({
                command: `${keyInput.binaryPath} app-server`,
                cause,
              }),
          ),
        );

        const existing = (yield* Ref.get(processesRef)).get(digest);
        if (existing === undefined) {
          yield* fs.remove(socketPath).pipe(Effect.ignore);
          const args = codexSessionAppServerArgs(undefined, keyInput.launchArgs, {
            listenUnixPath: socketPath,
            enableRealtimeConversation: keyInput.enableRealtimeConversation,
          });
          const env = {
            ...(keyInput.environment ?? process.env),
            CODEX_HOME: keyInput.codexHome,
          };
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
              Effect.mapError(
                (cause) =>
                  new CodexErrors.CodexAppServerSpawnError({
                    command: `${keyInput.binaryPath} app-server`,
                    cause,
                  }),
              ),
            );
          yield* fs.writeFileString(lockPath, String(child.pid ?? "unknown")).pipe(Effect.ignore);
          for (let attempt = 0; attempt < 50; attempt++) {
            const ready = yield* fs.exists(socketPath).pipe(Effect.orElseSucceed(() => false));
            if (ready) break;
            yield* Effect.sleep("50 millis");
          }
          yield* Ref.update(processesRef, (map) => {
            const next = new Map(map);
            next.set(digest, {
              key: digest,
              socketPath,
              lockPath,
              child,
              refCount: 1,
            });
            return next;
          });
        } else {
          yield* Ref.update(processesRef, (map) => {
            const current = map.get(digest);
            if (!current) return map;
            const next = new Map(map);
            next.set(digest, { ...current, refCount: current.refCount + 1 });
            return next;
          });
        }

        const supervised = (yield* Ref.get(processesRef)).get(digest);
        if (supervised === undefined) {
          return yield* new CodexErrors.CodexAppServerSpawnError({
            command: `${keyInput.binaryPath} app-server`,
            cause: new Error("supervised process missing after acquire"),
          });
        }

        const clientLayer = CodexClient.layerUnixSocket(supervised.socketPath);
        const clientContext = yield* clientLayer.pipe(Layer.build);
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(clientContext),
        );

        yield* Effect.addFinalizer(() =>
          Ref.update(processesRef, (map) => {
            const current = map.get(digest);
            if (!current) return map;
            const nextCount = current.refCount - 1;
            const next = new Map(map);
            if (nextCount <= 0) {
              next.delete(digest);
            } else {
              next.set(digest, { ...current, refCount: nextCount });
            }
            return next;
          }).pipe(Effect.asVoid),
        );

        return client;
      });

    return CodexAppServerSupervisor.of({
      topology: topologySetting,
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
  },
);

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
