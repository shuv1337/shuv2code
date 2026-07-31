import * as NodeAssert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  codexAppServerSupervisorKey,
  codexSessionAppServerArgs,
  stripCodexListenArgs,
} from "./codexLaunchArgs.ts";
import { layerTest } from "./CodexAppServerSupervisor.ts";
import { CodexAppServerSupervisor } from "../Services/CodexAppServerSupervisor.ts";

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

  it.effect("shared topology test layer fails closed without a real spawn", () =>
    Effect.gen(function* () {
      const supervisor = yield* CodexAppServerSupervisor;
      NodeAssert.equal(supervisor.topology, "shared");
      const error = yield* Effect.flip(
        supervisor.acquireConnection({
          binaryPath: "codex",
          codexHome: "/tmp/codex-home",
          launchArgs: "",
          enableRealtimeConversation: true,
          cwd: "/tmp",
          runtimeDir: "/tmp/shuv2code-runtime",
        }),
      );
      NodeAssert.equal(error._tag, "CodexAppServerSpawnError");
    }).pipe(Effect.provide(layerTest("shared"))),
  );
});
