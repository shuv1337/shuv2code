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

import { CheckpointRef } from "@shuv2code/contracts";
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
    startChange,
    describeChange,
    createWorktree,
    removeWorktree,
    fetch,
    listRefs,
    pushBookmark,
  } = driver;
  if (
    !status ||
    !createRef ||
    !startChange ||
    !describeChange ||
    !createWorktree ||
    !removeWorktree ||
    !fetch ||
    !listRefs ||
    !pushBookmark
  ) {
    throw new Error("JJ driver operations are incomplete");
  }
  return {
    status,
    createRef,
    startChange,
    describeChange,
    createWorktree,
    removeWorktree,
    fetch,
    listRefs,
    pushBookmark,
  };
}

it("reports native empty, dirty, bookmarked, and anonymous JJ status", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver } = yield* makeRepo;
      const ops = requireJjOperations(driver);

      const empty = yield* ops.status({ cwd });
      expect(empty.kind).toBe("jj");
      expect(empty.workingCopy?.isEmpty).toBe(true);
      expect(empty.workingCopy?.bookmarks).toEqual([]);
      expect(empty.workingCopy?.workspaceName).toBe("default");

      NodeFS.writeFileSync(NodePath.join(cwd, "dirty.txt"), "dirty\n");
      const dirty = yield* ops.status({ cwd });
      expect(dirty.hasWorkingTreeChanges).toBe(true);
      expect(dirty.workingTree.files.map((file) => file.path)).toEqual(["dirty.txt"]);
      expect(dirty.workingCopy?.hasConflicts).toBe(false);

      yield* ops.createRef({ cwd, refName: "feature/native" });
      const bookmarked = yield* ops.status({ cwd });
      expect(bookmarked.workingCopy?.bookmarks).toEqual(["feature/native"]);
      expect(bookmarked.refName).toBe("feature/native");

      yield* ops.startChange({ cwd });
      const anonymous = yield* ops.status({ cwd });
      expect(anonymous.refName).toBe(null);
      expect(anonymous.workingCopy?.bookmarks).toEqual([]);
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

it("creates and safely removes an exact JJ workspace path", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver, root } = yield* makeRepo;
      const ops = requireJjOperations(driver);

      NodeFS.writeFileSync(NodePath.join(cwd, "workspace.txt"), "base\n");
      yield* ops.describeChange({ cwd, description: "workspace base" });
      yield* ops.createRef({ cwd, refName: "workspace-base" });
      const workspacePath = NodePath.join(root, "exact-workspace");
      const created = yield* ops.createWorktree({
        cwd,
        refName: "workspace-base",
        path: workspacePath,
      });
      expect(created.worktree.path).toBe(workspacePath);
      expect(NodeFS.statSync(NodePath.join(workspacePath, ".jj", "repo")).isFile()).toBe(true);
      expect((yield* ops.status({ cwd: workspacePath })).workingCopy?.workspaceName).toBe(
        "workspace-base",
      );

      yield* ops.removeWorktree({ cwd, path: workspacePath });
      expect(NodeFS.existsSync(workspacePath)).toBe(false);
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
          (ref) => ref.name === "feature/remote" && ref.remoteName === "origin",
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

it("retains native JJ review and checkpoint behavior", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cwd, driver } = yield* makeRepo;
      const checkpoints = driver.checkpoints;
      const getDiffPreview = driver.getDiffPreview;
      if (!checkpoints || !getDiffPreview)
        throw new Error("JJ review/checkpoint operations missing");

      NodeFS.writeFileSync(NodePath.join(cwd, "review.txt"), "one\n");
      const first = CheckpointRef.make("refs/shuv2code/checkpoints/runtime/one");
      const second = CheckpointRef.make("refs/shuv2code/checkpoints/runtime/two");
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: first });
      NodeFS.writeFileSync(NodePath.join(cwd, "review.txt"), "two\n");
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: second });

      const diff = yield* checkpoints.diffCheckpoints({
        cwd,
        fromCheckpointRef: first,
        toCheckpointRef: second,
        ignoreWhitespace: false,
      });
      expect(diff).toContain("+two");
      expect((yield* getDiffPreview({ cwd })).sources[0]?.title).toBe("Working-copy change (@)");
      expect(yield* checkpoints.restoreCheckpoint({ cwd, checkpointRef: first })).toBe(true);
      expect(NodeFS.readFileSync(NodePath.join(cwd, "review.txt"), "utf8")).toBe("one\n");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));
