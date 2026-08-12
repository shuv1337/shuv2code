import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

function selectionTestLayer(input: {
  readonly defaultKind: "git" | "jj";
  readonly projectKind?: "git" | "jj" | "auto";
  readonly gitAvailable?: boolean;
  readonly jjAvailable?: boolean;
}) {
  return Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest({ defaultVcsKind: input.defaultKind })),
    Layer.provide(
      Layer.mock(VcsProjectConfig.VcsProjectConfig)({
        resolveKind: (request) =>
          Effect.succeed(request.requestedKind ?? input.projectKind ?? "auto"),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (request) => {
          if (request.command === "jj") {
            return Effect.succeed(
              input.jjAvailable === false
                ? {
                    ...processOutput(""),
                    exitCode: ChildProcessSpawner.ExitCode(1),
                  }
                : processOutput("/repo\n"),
            );
          }
          const command = normalizeGitArgs(request.args).join(" ");
          if (command === "rev-parse --is-inside-work-tree") {
            return Effect.succeed(
              input.gitAvailable === false
                ? {
                    ...processOutput(""),
                    exitCode: ChildProcessSpawner.ExitCode(128),
                  }
                : processOutput("true\n"),
            );
          }
          if (command === "rev-parse --show-toplevel")
            return Effect.succeed(processOutput("/repo\n"));
          if (command === "rev-parse --git-common-dir")
            return Effect.succeed(processOutput("/repo/.git\n"));
          return Effect.succeed(processOutput(""));
        },
      }),
    ),
  );
}

describe("VcsDriverRegistry", () => {
  it.effect("uses Git by default in a colocated repository", () =>
    Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const detected = yield* registry.resolve({ cwd: "/repo" });

      assert.equal(detected.kind, "git");
      assert.deepStrictEqual(detected.selection, {
        availableKinds: ["git", "jj"],
        projectKind: null,
        defaultKind: "git",
        source: "user-default",
      });
    }).pipe(Effect.provide(selectionTestLayer({ defaultKind: "git" }))),
  );

  it.effect("uses the user's Jujutsu default in a colocated repository", () =>
    Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const detected = yield* registry.resolve({ cwd: "/repo" });

      assert.equal(detected.kind, "jj");
      assert.equal(detected.selection?.defaultKind, "jj");
      assert.equal(detected.selection?.source, "user-default");
    }).pipe(Effect.provide(selectionTestLayer({ defaultKind: "jj" }))),
  );

  it.effect("lets a project override the user's default", () =>
    Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const detected = yield* registry.resolve({ cwd: "/repo" });

      assert.equal(detected.kind, "jj");
      assert.equal(detected.selection?.projectKind, "jj");
      assert.equal(detected.selection?.source, "project");
    }).pipe(Effect.provide(selectionTestLayer({ defaultKind: "git", projectKind: "jj" }))),
  );

  it.effect("falls back to Jujutsu when Git is not available", () =>
    Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const detected = yield* registry.resolve({ cwd: "/repo" });

      assert.equal(detected.kind, "jj");
      assert.deepStrictEqual(detected.selection?.availableKinds, ["jj"]);
      assert.equal(detected.selection?.source, "fallback");
    }).pipe(Effect.provide(selectionTestLayer({ defaultKind: "git", gitAvailable: false }))),
  );

  it.effect("routes directly by VCS driver kind for non-repository workflows", () => {
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: () => Effect.succeed(processOutput("")),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const driver = yield* registry.get("git");

      assert.strictEqual(driver.capabilities.kind, "git");
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches repository detection for repeated resolves in the same cwd and kind", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              calls.push(input);
              const normalizedArgs =
                input.args[0] === "-C" && input.args.length >= 2 ? input.args.slice(2) : input.args;
              const command = normalizedArgs.join(" ");
              if (command === "rev-parse --is-inside-work-tree") {
                return processOutput("true\n");
              }
              if (command === "rev-parse --show-toplevel") {
                return processOutput("/repo\n");
              }
              if (command === "rev-parse --git-common-dir") {
                return processOutput("/repo/.git\n");
              }
              return processOutput("");
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const first = yield* registry.resolve({ cwd: "/repo", requestedKind: "git" });
      const second = yield* registry.resolve({ cwd: "/repo", requestedKind: "git" });

      assert.equal(first.repository.rootPath, "/repo");
      assert.equal(second.repository.rootPath, "/repo");
      assert.deepStrictEqual(
        calls.map((call) => normalizeGitArgs(call.args).join(" ")),
        [
          "rev-parse --is-inside-work-tree",
          "rev-parse --show-toplevel",
          "rev-parse --git-common-dir",
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("detects a repository created after a negative lookup", () => {
    let insideWorkTreeChecks = 0;
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              const command = normalizeGitArgs(input.args).join(" ");
              if (command === "rev-parse --is-inside-work-tree") {
                insideWorkTreeChecks += 1;
                return insideWorkTreeChecks === 1
                  ? {
                      ...processOutput(""),
                      exitCode: ChildProcessSpawner.ExitCode(128),
                      stderr: "fatal: not a git repository",
                    }
                  : processOutput("true\n");
              }
              if (command === "rev-parse --show-toplevel") {
                return processOutput("/repo\n");
              }
              if (command === "rev-parse --git-common-dir") {
                return processOutput("/repo/.git\n");
              }
              return processOutput("");
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

      assert.equal(yield* registry.detect({ cwd: "/repo" }), null);
      assert.equal((yield* registry.detect({ cwd: "/repo" }))?.repository.rootPath, "/repo");
      assert.equal(insideWorkTreeChecks, 2);
    }).pipe(Effect.provide(layer));
  });
});
