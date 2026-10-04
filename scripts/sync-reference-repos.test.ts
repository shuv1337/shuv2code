import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { referenceRepos } from "./lib/reference-repos.ts";
import {
  dropUnmappedGitlinks,
  gitlinkPathsFromLsFiles,
  planReferenceRepoSync,
  resolveReferenceRepoRef,
  syncReferenceRepos,
  type ReferenceRepoSyncPlan,
} from "./sync-reference-repos.ts";

const workspaceRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      assert.fail(`git ${args.join(" ")} exited ${exitCode}: ${stderr}`);
    }
    return stdout;
  }).pipe(Effect.scoped);

const encoder = new TextEncoder();
const effectSmol = referenceRepos[0]!;
const alchemyEffect = referenceRepos[1]!;

function mockHandle(
  options: {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  } = {},
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(options.stdout ?? "done\n")),
    stderr: Stream.make(encoder.encode(options.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  handle = mockHandle(),
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(handle);
    }),
  );
}

it.layer(NodeServices.layer)("sync-reference-repos", (it) => {
  it.effect("resolves the effect-smol tag from the root catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-version-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      assert.equal(
        yield* resolveReferenceRepoRef(effectSmol, rootDir, false),
        "effect@4.0.0-beta.73",
      );
    }),
  );

  it.effect("uses the latest branch without reading package versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-latest-",
      });

      assert.equal(yield* resolveReferenceRepoRef(effectSmol, rootDir, true), "main");
    }),
  );

  it.effect("preserves version source read context and the filesystem cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-read-error-",
      });
      const sourcePath = path.join(rootDir, effectSmol.versionSourcePath);

      const error = yield* resolveReferenceRepoRef(effectSmol, rootDir, false).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoVersionSourceError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "read");
      assert.equal(error.repoId, effectSmol.id);
      assert.equal(error.sourcePath, sourcePath);
      assert.ok(error.cause !== undefined);
      assert.ok(!error.message.includes(String((error.cause as Error).message)));
    }),
  );

  it.effect("preserves version source parse context and the schema cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-parse-error-",
      });
      const sourcePath = path.join(rootDir, alchemyEffect.versionSourcePath);
      yield* fs.makeDirectory(path.dirname(sourcePath), { recursive: true });
      yield* fs.writeFileString(sourcePath, "{");

      const error = yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoVersionSourceError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "parse");
      assert.equal(error.repoId, alchemyEffect.id);
      assert.equal(error.sourcePath, sourcePath);
      assert.ok(error.cause !== undefined);
      assert.ok(!error.message.includes(String((error.cause as Error).message)));
    }),
  );

  it.effect("reports the unresolved package path without inventing a cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-resolution-error-",
      });
      const sourcePath = path.join(rootDir, alchemyEffect.versionSourcePath);
      yield* fs.makeDirectory(path.dirname(sourcePath), { recursive: true });
      yield* fs.writeFileString(sourcePath, '{"dependencies":{}}');

      const error = yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoVersionResolutionError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.repoId, alchemyEffect.id);
      assert.equal(error.sourcePath, sourcePath);
      assert.deepStrictEqual(error.packageVersionPath, ["dependencies", "alchemy"]);
      assert.ok(!("cause" in error));
    }),
  );

  it.effect("resolves the alchemy-effect tag from the relay package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-alchemy-version-",
      });
      yield* fs.makeDirectory(path.join(rootDir, "infra", "relay"), { recursive: true });
      yield* fs.writeFileString(
        path.join(rootDir, "infra", "relay", "package.json"),
        '{"dependencies":{"alchemy":"2.0.0-beta.49"}}',
      );

      assert.equal(yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false), "v2.0.0-beta.49");
    }),
  );

  it.effect("plans an add for a missing subtree and a pull for an existing subtree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-plan-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const addPlan = yield* planReferenceRepoSync(effectSmol, rootDir, false);
      assert.equal(addPlan.action, "add");
      assert.deepStrictEqual(addPlan.args, [
        "subtree",
        "add",
        "--prefix=.repos/effect-smol",
        "https://github.com/Effect-TS/effect.git",
        "effect@4.0.0-beta.73",
        "--squash",
      ]);

      yield* fs.makeDirectory(path.join(rootDir, effectSmol.prefix), { recursive: true });
      assert.equal((yield* planReferenceRepoSync(effectSmol, rootDir, false)).action, "pull");
    }),
  );

  it.effect("runs the planned git subtree command through the process service", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-run-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      yield* syncReferenceRepos({ rootDir, repoId: "effect-smol" }).pipe(
        Effect.provide(mockSpawnerLayer(commands)),
      );

      assert.deepStrictEqual(commands, [
        {
          command: "git",
          args: [
            "subtree",
            "add",
            "--prefix=.repos/effect-smol",
            "https://github.com/Effect-TS/effect.git",
            "effect@4.0.0-beta.73",
            "--squash",
          ],
        },
        {
          command: "git",
          args: ["ls-files", "-s", "-z", "--", ".repos/effect-smol"],
        },
      ]);
    });
  });

  it.effect("rejects unknown repo selectors", () =>
    Effect.gen(function* () {
      const error = yield* syncReferenceRepos({
        repoId: "missing",
        dryRun: true,
      }).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoSelectionError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.repoId, "missing");
      assert.deepStrictEqual(error.expectedRepoIds, ["effect-smol", "alchemy-effect"]);
      assert.ok(!("cause" in error));
    }),
  );

  it.effect("reports non-zero git exits without retaining process output", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-exit-error-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const error = yield* syncReferenceRepos({ rootDir, repoId: "effect-smol" }).pipe(
        Effect.provide(
          mockSpawnerLayer(
            commands,
            mockHandle({ exitCode: 23, stderr: "subtree failed secret-token-value\n" }),
          ),
        ),
        Effect.flip,
      );

      if (error._tag !== "ReferenceRepoGitSubtreeError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "exit");
      assert.equal(error.repoId, effectSmol.id);
      assert.equal(error.action, "add");
      assert.equal(error.repository, effectSmol.repository);
      assert.equal(error.ref, "effect@4.0.0-beta.73");
      assert.equal(error.rootDir, rootDir);
      assert.equal(error.argumentCount, commands[0]?.args.length);
      assert.equal(error.exitCode, 23);
      assert.equal(error.stdoutLength, 5);
      assert.equal(error.stderrLength, 34);
      assert.notProperty(error, "args");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "secret-token-value");
      assert.equal(error.step, "subtree");
      assert.ok(!("cause" in error));
    });
  });

  it.effect("reads only mode-160000 paths from ls-files output", () =>
    Effect.sync(() => {
      const output = [
        "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tREADME.md",
        "160000 c9f5e549cf023632c3df948c207a58336192b3c7 0\t.repos/alchemy-effect/.vendor/alchemy",
        "160000 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 0\t.repos/alchemy-effect/nested path",
        "",
      ].join("\0");

      assert.deepStrictEqual(gitlinkPathsFromLsFiles(output), [
        ".repos/alchemy-effect/.vendor/alchemy",
        ".repos/alchemy-effect/nested path",
      ]);
      assert.deepStrictEqual(gitlinkPathsFromLsFiles(""), []);
    }),
  );

  it.effect("commits removal of an unmapped gitlink without a .gitmodules entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-gitlink-",
      });
      const gitlink = `${alchemyEffect.prefix}/.vendor/alchemy`;
      const readme = path.join(rootDir, alchemyEffect.prefix, "README.md");
      yield* fs.makeDirectory(path.dirname(readme), { recursive: true });
      yield* fs.writeFileString(readme, "keep\n");

      const git = (args: ReadonlyArray<string>) => runGit(rootDir, args);
      yield* git(["init"]);
      yield* git(["config", "user.email", "papercut@example.com"]);
      yield* git(["config", "user.name", "Papercut"]);
      yield* git(["config", "commit.gpgsign", "false"]);
      yield* git(["add", "--", `${alchemyEffect.prefix}/README.md`]);
      yield* git(["commit", "-m", "init"]);
      yield* git([
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,c9f5e549cf023632c3df948c207a58336192b3c7,${gitlink}`,
      ]);
      yield* git(["commit", "-m", "add gitlink"]);

      const plan = {
        repo: alchemyEffect,
        action: "add",
        ref: "vtest",
        args: ["subtree", "add"],
      } satisfies ReferenceRepoSyncPlan;
      yield* dropUnmappedGitlinks(rootDir, plan).pipe(Effect.scoped);

      const listed = yield* git(["ls-files", "-s", "-z"]);
      assert.deepStrictEqual(gitlinkPathsFromLsFiles(listed), []);
      yield* git(["submodule", "status"]);
      yield* git(["submodule", "foreach", "--recursive", "git status --short"]);
      const subject = (yield* git(["log", "-1", "--format=%s"])).trim();
      assert.equal(subject, `chore: drop unmapped gitlinks under ${alchemyEffect.prefix}`);
      assert.equal(yield* git(["show", `HEAD:${alchemyEffect.prefix}/README.md`]), "keep\n");
    }),
  );

  it.effect("this checkout has no unmapped gitlinks", () =>
    Effect.gen(function* () {
      const listed = yield* runGit(workspaceRoot, ["ls-files", "-s", "-z"]);
      assert.deepStrictEqual(gitlinkPathsFromLsFiles(listed), []);
      yield* runGit(workspaceRoot, ["submodule", "status"]);
      yield* runGit(workspaceRoot, ["submodule", "foreach", "--recursive", "git status --short"]);
    }),
  );
});
