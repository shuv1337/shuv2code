// @effect-diagnostics nodeBuiltinImport:off - verifies PTY argument boundaries.
/* oxlint-disable shuv2code/no-manual-effect-runtime-in-tests -- Independent runtime probe while the Effect/Vite+ adapter fails before collection. */
import * as NodeServices from "@effect/platform-node/NodeServices";
// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { expect, it } from "vitest";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { DEFAULT_TERMINAL_ID } from "@shuv2code/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

const TestLayer = Layer.merge(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

it("launches Juzu with the selected workspace as a separate PTY argument", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "shuv2code-juzu-pty-" });
      const workspace = NodePath.join(root, "workspace with spaces");
      yield* fileSystem.makeDirectory(workspace);
      const spawnInputs: PtyAdapter.PtySpawnInput[] = [];
      const process: PtyAdapter.PtyProcess = {
        pid: 9191,
        write: () => {},
        resize: () => {},
        kill: () => {},
        onData: () => () => {},
        onExit: () => () => {},
      };
      const manager = yield* TerminalManager.makeWithOptions({
        logsDir: NodePath.join(root, "logs"),
        ptyAdapter: PtyAdapter.PtyAdapter.of({
          spawn: (input) => {
            spawnInputs.push(input);
            return Effect.succeed(process);
          },
        }),
        shellResolver: () => "/bin/bash",
        subprocessInspector: () =>
          Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
      });

      yield* manager.open({
        threadId: "thread-juzu",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: workspace,
        worktreePath: workspace,
        tool: "juzu",
      });
      expect(spawnInputs[0]).toMatchObject({
        shell: "juzu",
        args: ["--path", workspace],
        cwd: workspace,
      });

      yield* manager.open({
        threadId: "thread-shell",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: workspace,
      });
      expect(spawnInputs[1]).toMatchObject({ shell: "/bin/bash", cwd: workspace });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));
