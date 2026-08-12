// @effect-diagnostics nodeBuiltinImport:off - exercises disposable on-disk VCS repositories.
/* oxlint-disable shuv2code/no-manual-effect-runtime-in-tests -- Independent runtime probes while the Effect/Vite+ adapter fails before collection. */
import * as NodeServices from "@effect/platform-node/NodeServices";
// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { expect, it } from "vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const TestLayer = JjVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeRepo = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "shuv2code-jj-runtime-" });
  const cwd = NodePath.join(root, "repo");
  yield* fileSystem.makeDirectory(cwd);
  const driver = yield* VcsDriver.VcsDriver;
  yield* driver.initRepository({ cwd, kind: "jj" });
  return { cwd, driver, root };
});

function requireJjOperations(driver: VcsDriver.VcsDriver["Service"]) {
  const {
    status,
    createRef,
    switchRef,
    startChange,
    describeChange,
    fetch,
    listRefs,
    pushBookmark,
  } = driver;
  if (
    !status ||
    !createRef ||
    !switchRef ||
    !startChange ||
    !describeChange ||
    !fetch ||
    !listRefs ||
    !pushBookmark
  ) {
    throw new Error("JJ driver operations are incomplete");
  }
  return {
    status,
    createRef,
    switchRef,
    startChange,
    describeChange,
    fetch,
    listRefs,
    pushBookmark,
  };
}

it("detects and operates on the nearest JJ repository from nested paths", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver, root } = yield* makeRepo;
      const nested = NodePath.join(cwd, "apps", "server", "src");
      NodeFS.mkdirSync(nested, { recursive: true });

      expect((yield* driver.detectRepository(nested))?.rootPath).toBe(NodeFS.realpathSync(cwd));
      NodeFS.writeFileSync(NodePath.join(cwd, "nested.txt"), "nested\n");
      expect((yield* requireJjOperations(driver).status({ cwd: nested })).isRepo).toBe(true);

      const inner = NodePath.join(cwd, "packages", "inner");
      NodeFS.mkdirSync(inner, { recursive: true });
      yield* driver.initRepository({ cwd: inner, kind: "jj" });
      const innerNested = NodePath.join(inner, "src");
      NodeFS.mkdirSync(innerNested);
      expect((yield* driver.detectRepository(innerNested))?.rootPath).toBe(
        NodeFS.realpathSync(inner),
      );

      const boundary = NodePath.join(cwd, "malformed", ".jj");
      NodeFS.mkdirSync(NodePath.join(boundary, "deep"), { recursive: true });
      expect(yield* driver.detectRepository(NodePath.join(boundary, "deep"))).toBe(null);

      const outside = NodePath.join(root, "outside");
      NodeFS.mkdirSync(outside);
      expect(yield* driver.detectRepository(outside)).toBe(null);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("parses distinct JJ fetch and push URLs", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver } = yield* makeRepo;
      const fetchUrl = "https://example.invalid/upstream/project.git";
      const pushUrl = "ssh://git@example.invalid/fork/project.git";
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.addDistinctRemote",
        cwd,
        args: ["git", "remote", "add", "origin", fetchUrl],
      });
      NodeChildProcess.execFileSync("git", [
        "-C",
        cwd,
        "remote",
        "set-url",
        "--push",
        "origin",
        pushUrl,
      ]);

      const remote = (yield* driver.listRemotes(cwd)).remotes[0];
      expect(remote?.url).toBe(fetchUrl);
      expect(Option.getOrNull(remote?.pushUrl ?? Option.none())).toBe(pushUrl);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("initializes an option-shaped repository path as a destination operand", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "shuv2code-jj-option-init-",
      });
      const cwd = NodePath.join(root, "--help");
      yield* fileSystem.makeDirectory(cwd);
      const driver = yield* VcsDriver.VcsDriver;

      yield* driver.initRepository({ cwd, kind: "jj" });

      expect((yield* driver.detectRepository(cwd))?.rootPath).toBe(NodeFS.realpathSync(cwd));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("reports native empty, dirty, bookmarked, and anonymous JJ status", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver } = yield* makeRepo;
      const ops = requireJjOperations(driver);

      const empty = yield* ops.status({ cwd });
      expect(empty.kind).toBe("jj");
      expect(empty.capabilities?.supportsAtomicSnapshot).toBe(false);
      expect(empty.capabilities?.supportsWorktrees).toBe(false);
      expect(empty.capabilities?.supportsWorkspaceMutation).toBe(false);
      expect(driver.checkpoints).toBeUndefined();
      expect(driver.createWorktree).toBeUndefined();
      expect(driver.removeWorktree).toBeUndefined();
      expect(empty.workingCopy?.isEmpty).toBe(true);
      expect(empty.workingCopy?.bookmarks).toEqual([]);
      expect(empty.workingCopy?.workspaceName).toBe("default");

      NodeFS.writeFileSync(NodePath.join(cwd, "dirty.txt"), "dirty\n");
      const dirty = yield* ops.status({ cwd });
      expect(dirty.hasWorkingTreeChanges).toBe(true);
      expect(dirty.workingTree.files.map((file) => file.path)).toEqual(["dirty.txt"]);
      expect(dirty.workingCopy?.hasConflicts).toBe(false);

      yield* ops.createRef({ cwd, refName: "feature/native" });
      const colocatedRefs = yield* ops.listRefs({ cwd, limit: 100 });
      expect(colocatedRefs.refs.some((ref) => ref.name.endsWith("@git"))).toBe(false);
      expect(colocatedRefs.refs.find((ref) => ref.name === "feature/native")?.tracking?.state).toBe(
        "untracked",
      );
      const bookmarked = yield* ops.status({ cwd });
      expect(bookmarked.workingCopy?.bookmarks).toEqual(["feature/native"]);
      expect(bookmarked.refName).toBe("feature/native");

      yield* ops.startChange({ cwd });
      const anonymous = yield* ops.status({ cwd });
      expect(anonymous.refName).toBe(null);
      expect(anonymous.workingCopy?.bookmarks).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("treats bookmark names that look like revsets as exact names", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver } = yield* makeRepo;
      const ops = requireJjOperations(driver);
      NodeFS.writeFileSync(NodePath.join(cwd, "special.txt"), "special\n");
      yield* ops.describeChange({ cwd, description: "special bookmark" });
      yield* ops.createRef({ cwd, refName: "root()" });
      const bookmarkCommitId = (yield* ops.status({ cwd })).workingCopy?.commitId;
      yield* ops.startChange({ cwd });

      yield* ops.switchRef({ cwd, refName: "root()" });

      expect((yield* ops.status({ cwd })).workingCopy?.commitId).toBe(bookmarkCommitId);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("surfaces conflicted files explicitly", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver } = yield* makeRepo;
      const ops = requireJjOperations(driver);

      NodeFS.writeFileSync(NodePath.join(cwd, "conflict.txt"), "base\n");
      yield* ops.describeChange({ cwd, description: "base" });
      yield* ops.startChange({ cwd });
      NodeFS.writeFileSync(NodePath.join(cwd, "conflict.txt"), "left\n");
      yield* ops.describeChange({ cwd, description: "left" });
      const left = yield* ops.status({ cwd });

      yield* ops.startChange({ cwd, parentRevision: "@-" });
      NodeFS.writeFileSync(NodePath.join(cwd, "conflict.txt"), "right\n");
      yield* ops.describeChange({ cwd, description: "right" });
      const right = yield* ops.status({ cwd });

      yield* driver.execute({
        operation: "JjVcsDriver.runtime.mergeConflict",
        cwd,
        args: ["new", left.workingCopy?.changeId ?? "", right.workingCopy?.changeId ?? ""],
      });
      const conflicted = yield* ops.status({ cwd });
      expect(conflicted.workingCopy?.hasConflicts).toBe(true);
      expect(conflicted.workingCopy?.conflictPaths).toEqual(["conflict.txt"]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("rejects option-like JJ ref operands before invoking the CLI", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver } = yield* makeRepo;
      const ops = requireJjOperations(driver);
      const before = (yield* ops.status({ cwd })).workingCopy?.commitId;

      const createError = yield* ops.createRef({ cwd, refName: "--help" }).pipe(Effect.flip);
      expect(createError.message).toContain("must not start with '-'");

      const switchError = yield* ops.switchRef({ cwd, refName: "--help" }).pipe(Effect.flip);
      expect(switchError.message).toContain("must not start with '-'");

      const startError = yield* ops
        .startChange({ cwd, parentRevision: "--help" })
        .pipe(Effect.flip);
      expect(startError.message).toContain("must not start with '-'");

      const fetchError = yield* ops.fetch({ cwd, remoteName: "--help" }).pipe(Effect.flip);
      expect(fetchError.message).toContain("must not start with '-'");

      const pushError = yield* ops
        .pushBookmark({ cwd, bookmarkName: "missing", remoteName: "--help" })
        .pipe(Effect.flip);
      expect(pushError.message).toContain("must not start with '-'");

      expect((yield* ops.status({ cwd })).workingCopy?.commitId).toBe(before);
      expect((yield* ops.listRefs({ cwd, query: "--help" })).refs).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("reports a tracked current bookmark beyond the first 200 refs", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver, root } = yield* makeRepo;
      const ops = requireJjOperations(driver);
      const remotePath = NodePath.join(root, "pagination-remote.git");
      NodeChildProcess.execFileSync("git", ["init", "--bare", remotePath], { stdio: "ignore" });
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.addPaginationRemote",
        cwd,
        args: ["git", "remote", "add", "origin", remotePath],
      });

      NodeFS.writeFileSync(NodePath.join(cwd, "current.txt"), "current\n");
      yield* ops.describeChange({ cwd, description: "current bookmark" });
      yield* ops.createRef({ cwd, refName: "zz-current" });
      yield* ops.pushBookmark({ cwd, bookmarkName: "zz-current", remoteName: "origin" });

      const decoys = Array.from(
        { length: 200 },
        (_, index) => `aa-decoy-${index.toString().padStart(3, "0")}`,
      );
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.addPaginationDecoys",
        cwd,
        args: ["bookmark", "set", "--allow-backwards", ...decoys, "-r", "@-"],
      });

      const firstPage = yield* ops.listRefs({ cwd, limit: 200 });
      expect(firstPage.nextCursor).toBe(200);
      expect(firstPage.refs.some((ref) => ref.name === "zz-current")).toBe(false);

      const status = yield* ops.status({ cwd });
      expect(status.refName).toBe("zz-current");
      expect(status.workingCopy?.bookmarks).toEqual(["zz-current"]);
      expect(status.hasUpstream).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("resolves the standard trunk expression and keeps an ahead local bookmark default", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver, root } = yield* makeRepo;
      const ops = requireJjOperations(driver);
      const remotePath = NodePath.join(root, "default-remote.git");
      NodeChildProcess.execFileSync("git", ["init", "--bare", remotePath], { stdio: "ignore" });
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.addDefaultRemote",
        cwd,
        args: ["git", "remote", "add", "origin", remotePath],
      });
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.allowCurrentDefault",
        cwd,
        args: ["config", "set", "--repo", 'revset-aliases."immutable_heads()"', "none()"],
      });

      NodeFS.writeFileSync(NodePath.join(cwd, "default.txt"), "default\n");
      yield* ops.describeChange({ cwd, description: "default commit" });
      yield* ops.createRef({ cwd, refName: "main" });
      yield* ops.createRef({ cwd, refName: "alias" });
      yield* ops.pushBookmark({ cwd, bookmarkName: "main", remoteName: "origin" });
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.configureTrunk",
        cwd,
        args: [
          "config",
          "set",
          "--repo",
          'revset-aliases."trunk()"',
          'latest(remote_bookmarks(exact:"main", exact:"origin") | root())',
        ],
      });

      const refs = (yield* ops.listRefs({ cwd, limit: 100 })).refs;
      expect(refs.filter((ref) => ref.isDefault).map((ref) => ref.name)).toEqual(["main"]);
      expect(refs.find((ref) => ref.name === "alias")?.isDefault).toBe(false);
      expect(refs.find((ref) => ref.name === "main@origin")?.isDefault).toBe(false);
      const status = yield* ops.status({ cwd });
      expect(status.refName).toBe("main");
      expect(status.isDefaultRef).toBe(true);

      yield* ops.startChange({ cwd });
      NodeFS.writeFileSync(NodePath.join(cwd, "ahead.txt"), "ahead\n");
      yield* ops.describeChange({ cwd, description: "ahead of default" });
      yield* ops.createRef({ cwd, refName: "main" });

      const aheadRefs = (yield* ops.listRefs({ cwd, limit: 100 })).refs;
      expect(aheadRefs.find((ref) => ref.name === "main")?.isDefault).toBe(true);
      expect((yield* ops.status({ cwd })).isDefaultRef).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("starts a child change instead of editing an immutable trunk target", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver } = yield* makeRepo;
      const ops = requireJjOperations(driver);
      NodeFS.writeFileSync(NodePath.join(cwd, "main.txt"), "main\n");
      yield* ops.describeChange({ cwd, description: "main" });
      yield* ops.createRef({ cwd, refName: "main" });
      const immutableCommitId = (yield* ops.status({ cwd })).workingCopy?.commitId;
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.markMainImmutable",
        cwd,
        args: ["config", "set", "--repo", 'revset-aliases."immutable_heads()"', "main"],
      });

      yield* ops.switchRef({ cwd, refName: "main" });

      const switched = yield* ops.status({ cwd });
      expect(switched.workingCopy?.commitId).not.toBe(immutableCommitId);
      const parentId = NodeChildProcess.execFileSync(
        "jj",
        ["--ignore-working-copy", "-R", cwd, "log", "--no-graph", "-r", "@-", "-T", "commit_id"],
        { encoding: "utf8" },
      ).trim();
      expect(parentId).toBe(immutableCommitId);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("represents and switches remote JJ bookmarks by name@remote", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver, root } = yield* makeRepo;
      const ops = requireJjOperations(driver);
      const remotePath = NodePath.join(root, "switch-remote.git");
      NodeChildProcess.execFileSync("git", ["init", "--bare", remotePath], { stdio: "ignore" });
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.addSwitchRemote",
        cwd,
        args: ["git", "remote", "add", "origin", remotePath],
      });

      NodeFS.writeFileSync(NodePath.join(cwd, "remote-switch.txt"), "remote\n");
      yield* ops.describeChange({ cwd, description: "remote target" });
      yield* ops.createRef({ cwd, refName: "feature/remote-switch" });
      const remoteCommitId = (yield* ops.status({ cwd })).workingCopy?.commitId;
      yield* ops.pushBookmark({
        cwd,
        bookmarkName: "feature/remote-switch",
        remoteName: "origin",
      });

      const remoteRef = (yield* ops.listRefs({ cwd, refKind: "remote" })).refs.find(
        (ref) => ref.remoteName === "origin",
      );
      expect(remoteRef?.name).toBe("feature/remote-switch@origin");

      yield* ops.startChange({ cwd });
      NodeFS.appendFileSync(NodePath.join(cwd, "remote-switch.txt"), "local\n");
      yield* ops.describeChange({ cwd, description: "local target" });
      yield* ops.createRef({ cwd, refName: "feature/remote-switch" });
      expect((yield* ops.status({ cwd })).workingCopy?.commitId).not.toBe(remoteCommitId);

      yield* ops.switchRef({ cwd, refName: remoteRef?.name ?? "missing@origin" });
      expect((yield* ops.status({ cwd })).workingCopy?.commitId).toBe(remoteCommitId);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("fetches, pushes, and reports tracked, behind, and divergent bookmarks", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver, root } = yield* makeRepo;
      const ops = requireJjOperations(driver);

      const remotePath = NodePath.join(root, "remote.git");
      NodeChildProcess.execFileSync("git", ["init", "--bare", remotePath], { stdio: "ignore" });
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.addRemote",
        cwd,
        args: ["git", "remote", "add", "origin", remotePath],
      });
      NodeFS.writeFileSync(NodePath.join(cwd, "remote.txt"), "one\n");
      yield* ops.describeChange({ cwd, description: "remote one" });
      yield* ops.createRef({ cwd, refName: "feature/remote" });
      const originalCommitId = (yield* ops.status({ cwd })).workingCopy?.commitId ?? "";
      expect(originalCommitId).toBeTruthy();
      yield* ops.pushBookmark({ cwd, bookmarkName: "feature/remote", remoteName: "origin" });

      const synced = (yield* ops.listRefs({ cwd, refKind: "local" })).refs.find(
        (ref) => ref.name === "feature/remote",
      );
      expect(synced?.tracking?.state).toBe("synced");
      expect(
        (yield* ops.listRefs({ cwd, refKind: "remote" })).refs.some(
          (ref) => ref.name === "feature/remote@origin" && ref.remoteName === "origin",
        ),
      ).toBe(true);

      const clonePath = NodePath.join(root, "clone");
      NodeChildProcess.execFileSync(
        "git",
        ["clone", "--branch", "feature/remote", remotePath, clonePath],
        { stdio: "ignore" },
      );
      NodeChildProcess.execFileSync("git", ["-C", clonePath, "config", "user.name", "JJ Test"]);
      NodeChildProcess.execFileSync("git", [
        "-C",
        clonePath,
        "config",
        "user.email",
        "jj@test.invalid",
      ]);
      NodeFS.appendFileSync(NodePath.join(clonePath, "remote.txt"), "remote\n");
      NodeChildProcess.execFileSync("git", ["-C", clonePath, "add", "remote.txt"]);
      NodeChildProcess.execFileSync("git", ["-C", clonePath, "commit", "-m", "remote advance"], {
        stdio: "ignore",
      });
      NodeChildProcess.execFileSync("git", ["-C", clonePath, "push", "origin", "feature/remote"], {
        stdio: "ignore",
      });

      yield* ops.fetch({ cwd, remoteName: "origin" });
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.moveBookmarkBehind",
        cwd,
        args: [
          "bookmark",
          "set",
          "--allow-backwards",
          "feature/remote",
          "-r",
          originalCommitId ?? "",
        ],
      });
      const behind = (yield* ops.listRefs({ cwd, refKind: "local" })).refs.find(
        (ref) => ref.name === "feature/remote",
      );
      expect(behind?.tracking?.state).toBe("behind");
      expect(behind?.tracking?.behindCount).toBe(1);

      yield* ops.startChange({ cwd, parentRevision: originalCommitId });
      NodeFS.appendFileSync(NodePath.join(cwd, "remote.txt"), "local\n");
      yield* ops.describeChange({ cwd, description: "local advance" });
      yield* ops.createRef({ cwd, refName: "feature/remote" });
      const divergent = (yield* ops.listRefs({ cwd, refKind: "local" })).refs.find(
        (ref) => ref.name === "feature/remote",
      );
      expect(divergent?.tracking?.state).toBe("divergent");
      expect((divergent?.tracking?.aheadCount ?? 0) > 0).toBe(true);
      expect((divergent?.tracking?.behindCount ?? 0) > 0).toBe(true);

      const rejected = yield* ops
        .pushBookmark({ cwd, bookmarkName: "feature/remote", remoteName: "origin" })
        .pipe(Effect.flip);
      expect(rejected.message).toContain("divergent");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));

it("requires an explicit remote when multiple non-origin remotes exist", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver, root } = yield* makeRepo;
      const ops = requireJjOperations(driver);
      for (const remoteName of ["alpha", "beta"] as const) {
        const remotePath = NodePath.join(root, `${remoteName}.git`);
        NodeChildProcess.execFileSync("git", ["init", "--bare", remotePath], { stdio: "ignore" });
        yield* driver.execute({
          operation: `JjVcsDriver.runtime.addRemote.${remoteName}`,
          cwd,
          args: ["git", "remote", "add", remoteName, remotePath],
        });
      }
      NodeFS.writeFileSync(NodePath.join(cwd, "ambiguous.txt"), "ambiguous\n");
      yield* ops.describeChange({ cwd, description: "ambiguous remote" });
      yield* ops.createRef({ cwd, refName: "main" });
      const initialLocalCommitId = (yield* ops.status({ cwd })).workingCopy?.commitId;
      expect(initialLocalCommitId).toBeTruthy();

      const remotes = yield* driver.listRemotes(cwd);
      expect(remotes.remotes.some((remote) => remote.isPrimary)).toBe(false);
      expect((yield* ops.status({ cwd })).hasPrimaryRemote).toBe(false);
      expect((yield* ops.fetch({ cwd }).pipe(Effect.flip)).message).toContain(
        "Choose a remote explicitly",
      );
      expect(
        (yield* ops.pushBookmark({ cwd, bookmarkName: "main" }).pipe(Effect.flip)).message,
      ).toContain("Choose a remote explicitly");

      expect((yield* ops.fetch({ cwd, remoteName: "alpha" })).remoteName).toBe("alpha");
      expect(
        (yield* ops.pushBookmark({ cwd, bookmarkName: "main", remoteName: "alpha" })).remoteName,
      ).toBe("alpha");
      NodeChildProcess.execFileSync(
        "git",
        [
          "--git-dir",
          NodePath.join(root, "beta.git"),
          "fetch",
          NodePath.join(root, "alpha.git"),
          "main:main",
        ],
        { stdio: "ignore" },
      );
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.allowCurrentMultiRemoteBookmark",
        cwd,
        args: ["config", "set", "--repo", 'revset-aliases."immutable_heads()"', "none()"],
      });
      yield* ops.fetch({ cwd, remoteName: "beta" });
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.trackBeta",
        cwd,
        args: ["bookmark", "track", "main", "--remote", "beta"],
      });
      expect(
        (yield* ops.pushBookmark({ cwd, bookmarkName: "main", remoteName: "beta" })).remoteName,
      ).toBe("beta");

      const betaClonePath = NodePath.join(root, "beta-clone");
      NodeChildProcess.execFileSync(
        "git",
        ["clone", "--branch", "main", NodePath.join(root, "beta.git"), betaClonePath],
        { stdio: "ignore" },
      );
      NodeChildProcess.execFileSync("git", ["-C", betaClonePath, "config", "user.name", "JJ Test"]);
      NodeChildProcess.execFileSync("git", [
        "-C",
        betaClonePath,
        "config",
        "user.email",
        "jj@test.invalid",
      ]);
      NodeFS.appendFileSync(NodePath.join(betaClonePath, "ambiguous.txt"), "beta\n");
      NodeChildProcess.execFileSync("git", ["-C", betaClonePath, "add", "ambiguous.txt"]);
      NodeChildProcess.execFileSync("git", ["-C", betaClonePath, "commit", "-m", "beta advance"], {
        stdio: "ignore",
      });
      NodeChildProcess.execFileSync("git", ["-C", betaClonePath, "push", "origin", "main"], {
        stdio: "ignore",
      });

      yield* ops.startChange({ cwd });
      NodeFS.appendFileSync(NodePath.join(cwd, "ambiguous.txt"), "local\n");
      yield* ops.describeChange({ cwd, description: "local advance" });
      yield* ops.createRef({ cwd, refName: "main" });
      const localAdvanceCommitId = (yield* ops.status({ cwd })).workingCopy?.commitId;
      expect(localAdvanceCommitId).toBeTruthy();
      yield* ops.fetch({ cwd, remoteName: "beta" });
      yield* driver.execute({
        operation: "JjVcsDriver.runtime.resolveLocalMainAfterBetaFetch",
        cwd,
        args: [
          "bookmark",
          "set",
          "--allow-backwards",
          '"main"',
          "-r",
          localAdvanceCommitId ?? initialLocalCommitId ?? "",
        ],
      });

      const rejectedBetaPush = yield* ops
        .pushBookmark({ cwd, bookmarkName: "main", remoteName: "beta" })
        .pipe(Effect.flip);
      expect(rejectedBetaPush.message).toContain("divergent");
      expect(rejectedBetaPush.message).toContain("beta");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));
