// @effect-diagnostics nodeBuiltinImport:off - exercises a disposable real Git worktree.
import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as VcsProjectConfig from "./VcsProjectConfig.ts";

const TestLayer = VcsProjectConfig.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.sync(() => {
    NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  });

describe("VcsProjectConfig", () => {
  it("keeps operation context and the original cause on config errors", () => {
    const cause = new Error("permission denied");
    const error = new VcsProjectConfig.VcsProjectConfigError({
      operation: "read",
      cwd: "/repo/packages/app",
      configPath: "/repo/.shuv2code/vcs.json",
      cause,
    });

    assert.equal(error.operation, "read");
    assert.equal(error.cwd, "/repo/packages/app");
    assert.equal(error.configPath, "/repo/.shuv2code/vcs.json");
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message, "Failed to read VCS project config at /repo/.shuv2code/vcs.json.");
  });

  it.layer(TestLayer)("uses an explicit requested VCS kind before config", (it) => {
    it.effect("returns the requested kind", () =>
      Effect.gen(function* () {
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({
          cwd: "/repo",
          requestedKind: "jj",
        });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("discovers .shuv2code/vcs.json from nested workspaces", (it) => {
    it.effect("returns the configured kind", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "shuv2code-vcs-config-test-",
        });
        const configDir = path.join(root, ".shuv2code");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: nested });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("stops config discovery at a resolved repository root", (it) => {
    it.effect("does not inherit an unrelated ancestor config", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ancestor = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "shuv2code-vcs-config-boundary-test-",
        });
        const ancestorConfigDir = path.join(ancestor, ".shuv2code");
        const repository = path.join(ancestor, "repository");
        const nested = path.join(repository, "packages", "app");
        yield* fileSystem.makeDirectory(ancestorConfigDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(ancestorConfigDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "jj" } }),
        );
        yield* runGit(repository, ["init", "--quiet"]);

        const config = yield* VcsProjectConfig.VcsProjectConfig;

        assert.equal(yield* config.resolveKind({ cwd: nested }), "auto");
      }),
    );
  });

  it.layer(TestLayer)("shares preferences across real Git worktrees", (it) => {
    it.effect("writes through a linked worktree to the primary project config", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "shuv2code-vcs-config-git-worktree-test-",
        });
        const primary = path.join(root, "primary");
        const linkedOne = path.join(root, "linked-one");
        const linkedTwo = path.join(root, "linked-two");
        const nestedLinkedOne = path.join(linkedOne, "packages", "app");
        const nestedLinkedTwo = path.join(linkedTwo, "packages", "app");
        yield* fileSystem.makeDirectory(primary, { recursive: true });
        yield* runGit(primary, ["init", "--quiet"]);
        yield* runGit(primary, [
          "-c",
          "user.name=shuv2code test",
          "-c",
          "user.email=test@shuv2code.local",
          "commit",
          "--allow-empty",
          "--quiet",
          "-m",
          "initial",
        ]);
        yield* runGit(primary, ["worktree", "add", "--quiet", "--detach", linkedOne]);
        yield* runGit(primary, ["worktree", "add", "--quiet", "--detach", linkedTwo]);
        yield* fileSystem.makeDirectory(nestedLinkedOne, { recursive: true });
        yield* fileSystem.makeDirectory(nestedLinkedTwo, { recursive: true });

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        yield* config.setKind({ cwd: nestedLinkedOne, kind: "jj" });

        const primaryConfig = path.join(primary, ".shuv2code", "vcs.json");
        assert.isTrue(yield* fileSystem.exists(primaryConfig));
        assert.isFalse(yield* fileSystem.exists(path.join(linkedOne, ".shuv2code", "vcs.json")));
        assert.isFalse(yield* fileSystem.exists(path.join(linkedTwo, ".shuv2code", "vcs.json")));
        assert.equal(yield* config.resolveKind({ cwd: primary }), "jj");
        assert.equal(yield* config.resolveKind({ cwd: nestedLinkedOne }), "jj");
        assert.equal(yield* config.resolveKind({ cwd: nestedLinkedTwo }), "jj");

        yield* config.setKind({ cwd: primary, kind: "git" });
        assert.equal(yield* config.resolveKind({ cwd: linkedOne }), "git");
        assert.equal(yield* config.resolveKind({ cwd: linkedTwo }), "git");
      }),
    );
  });

  it.layer(TestLayer)("shares preferences across JJ workspace pointers", (it) => {
    it.effect("resolves relative and absolute pointers to the primary project config", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "shuv2code-vcs-config-jj-workspace-test-",
        });
        const primary = path.join(root, "primary");
        const primaryRepo = path.join(primary, ".jj", "repo");
        const relativeWorkspace = path.join(root, "relative-workspace");
        const absoluteWorkspace = path.join(root, "absolute-workspace");
        const relativeRepoPointer = path.join(relativeWorkspace, ".jj", "repo");
        const absoluteRepoPointer = path.join(absoluteWorkspace, ".jj", "repo");
        yield* fileSystem.makeDirectory(primaryRepo, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(relativeRepoPointer), { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(absoluteRepoPointer), { recursive: true });
        yield* fileSystem.writeFileString(
          relativeRepoPointer,
          path.relative(path.dirname(relativeRepoPointer), primaryRepo),
        );
        yield* fileSystem.writeFileString(absoluteRepoPointer, primaryRepo);
        const nestedRelative = path.join(relativeWorkspace, "packages", "app");
        const nestedAbsolute = path.join(absoluteWorkspace, "packages", "app");
        yield* fileSystem.makeDirectory(nestedRelative, { recursive: true });
        yield* fileSystem.makeDirectory(nestedAbsolute, { recursive: true });

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        yield* config.setKind({ cwd: nestedRelative, kind: "jj" });

        assert.isTrue(yield* fileSystem.exists(path.join(primary, ".shuv2code", "vcs.json")));
        assert.isFalse(
          yield* fileSystem.exists(path.join(relativeWorkspace, ".shuv2code", "vcs.json")),
        );
        assert.isFalse(
          yield* fileSystem.exists(path.join(absoluteWorkspace, ".shuv2code", "vcs.json")),
        );
        assert.equal(yield* config.resolveKind({ cwd: primary }), "jj");
        assert.equal(yield* config.resolveKind({ cwd: nestedAbsolute }), "jj");

        yield* config.setKind({ cwd: absoluteWorkspace, kind: null });
        assert.equal(yield* config.resolveKind({ cwd: nestedRelative }), "auto");
      }),
    );
  });

  it.layer(TestLayer)("continues to parent configs after a candidate inspect failure", (it) => {
    it.effect("logs the failed candidate and returns the parent config", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "shuv2code-vcs-config-test-",
        });
        const configDir = path.join(root, ".shuv2code");
        const cwd = path.join(root, "invalid\0child");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd });

        assert.equal(kind, "jj");
        const failedCandidate = path.join(cwd, ".shuv2code", "vcs.json");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(
          error.message,
          "Failed to inspect VCS project config at " + failedCandidate + ".",
        );
        assert.deepInclude(error, {
          operation: "inspect",
          cwd,
          configPath: failedCandidate,
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(TestLayer)("falls back to auto when no config exists", (it) => {
    it.effect("returns auto", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "shuv2code-vcs-config-test-",
        });
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
      }),
    );
  });

  it.layer(TestLayer)("persists project-level VCS choices", (it) => {
    it.effect("switches between an explicit choice and the user default", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "shuv2code-vcs-config-test-",
        });
        const config = yield* VcsProjectConfig.VcsProjectConfig;

        yield* config.setKind({ cwd: root, kind: "jj" });
        assert.equal(yield* config.resolveKind({ cwd: root }), "jj");
        assert.isTrue(yield* fileSystem.exists(path.join(root, ".shuv2code", "vcs.json")));

        yield* config.setKind({ cwd: root, kind: null });
        assert.equal(yield* config.resolveKind({ cwd: root }), "auto");
      }),
    );
  });

  it.layer(TestLayer)("falls back to auto when config JSON is malformed", (it) => {
    it.effect("returns auto and logs the failed operation and path", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "shuv2code-vcs-config-test-",
        });
        const configDir = path.join(root, ".shuv2code");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(configDir, "vcs.json"), "{not json");

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(
          error.message,
          "Failed to decode VCS project config at " + path.join(configDir, "vcs.json") + ".",
        );
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
        assert.deepInclude(error, {
          operation: "decode",
          cwd: root,
          configPath: path.join(configDir, "vcs.json"),
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(TestLayer)("falls back to auto when the config path cannot be read", (it) => {
    it.effect("retains the read failure context", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "shuv2code-vcs-config-test-",
        });
        const configPath = path.join(root, ".shuv2code", "vcs.json");
        yield* fileSystem.makeDirectory(configPath, { recursive: true });

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(error.message, "Failed to read VCS project config at " + configPath + ".");
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
        assert.deepInclude(error, {
          operation: "read",
          cwd: root,
          configPath,
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(TestLayer)("falls back to auto when config kind is invalid", (it) => {
    it.effect("returns auto", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "shuv2code-vcs-config-test-",
        });
        const configDir = path.join(root, ".shuv2code");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          `{"vcs":{"kind":"svn"}}`,
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
      }),
    );
  });
});
