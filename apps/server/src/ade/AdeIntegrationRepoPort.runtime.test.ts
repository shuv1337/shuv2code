// @effect-diagnostics nodeBuiltinImport:off - exercises a disposable on-disk JJ repository.
/**
 * Real-`jj` coverage for the integration service's mechanics half (spec §4.4,
 * ADR §6.2, §14.4). The state machine itself is covered against a stub port in
 * `AdeIntegrationService.test.ts`; this file proves the JJ operations behind it
 * actually work — isolated workspaces, rebase-onto-canonical, conflict
 * detection, canonical advancement, and re-runnable cleanup.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as ProcessRunner from "../processRunner.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { AdeIntegrationRepoPort, layer as repoPortLayer } from "./AdeIntegrationRepoPort.ts";

const TestLayer = repoPortLayer.pipe(
  Layer.provideMerge(JjVcsDriver.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

interface Repo {
  readonly repoPath: string;
  readonly root: string;
  readonly jj: (
    args: ReadonlyArray<string>,
    cwd?: string,
  ) => Effect.Effect<string, never, VcsDriver.VcsDriver>;
}

/**
 * A colocated JJ repo with a `main` bookmark on a base commit. `immutable_heads`
 * is disabled so the port's `bookmark set --allow-backwards` behaves the way it
 * does in the fixture repos elsewhere in this suite.
 */
const makeRepo = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const driver = yield* VcsDriver.VcsDriver;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "shuv2code-ade-integration-" });
  const repoPath = NodePath.join(root, "repo");
  yield* fileSystem.makeDirectory(repoPath);
  yield* driver.initRepository({ cwd: repoPath, kind: "jj" });

  const jj = (args: ReadonlyArray<string>, cwd: string = repoPath) =>
    driver
      .execute({ operation: "AdeIntegrationRepoPort.test", cwd, args, allowNonZeroExit: true })
      .pipe(
        Effect.map((result) => `${result.stdout}${result.stderr}`),
        Effect.orDie,
      );

  yield* jj(["config", "set", "--repo", "user.name", "ADE Test"]);
  yield* jj(["config", "set", "--repo", "user.email", "ade@test.invalid"]);
  yield* jj(["config", "set", "--repo", "revset-aliases.immutable_heads()", "none()"]);

  yield* fileSystem.writeFileString(NodePath.join(repoPath, "base.txt"), "base\n");
  yield* jj(["describe", "-m", "base"]);
  yield* jj(["bookmark", "set", "main", "--revision", "@", "--allow-backwards"]);

  return { repoPath, root, jj } satisfies Repo;
});

/** Create a change off `main` and park `@` elsewhere so a workspace may edit it. */
const makeCandidateChange = (repo: Repo, fileName: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* repo.jj(["new", '"main"']);
    yield* fileSystem.writeFileString(NodePath.join(repo.repoPath, fileName), contents);
    yield* repo.jj(["describe", "-m", `candidate ${fileName}`]);
    const changeId = (yield* repo.jj(["log", "--no-graph", "-r", "@", "-T", 'change_id ++ "\\n"']))
      .trim()
      .split("\n")[0] as string;
    // Move the working copy off the candidate: two workspaces may not edit the
    // same commit, and the port's workspace will want to.
    yield* repo.jj(["new", '"main"']);
    return changeId;
  });

const runtime = <A, E>(
  name: string,
  body: () => Effect.Effect<
    A,
    E,
    AdeIntegrationRepoPort | VcsDriver.VcsDriver | FileSystem.FileSystem | Scope.Scope
  >,
) => it.effect(name, () => Effect.scoped(Effect.provide(body(), TestLayer)), { timeout: 120_000 });

runtime("prepares an isolated workspace, runs checks, and advances canonical", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const port = yield* AdeIntegrationRepoPort;
    const repo = yield* makeRepo;
    const changeId = yield* makeCandidateChange(repo, "feature.txt", "feature\n");

    const workspacePath = NodePath.join(repo.root, "work", "candidate-1");
    const prepared = yield* port.prepareCandidateWorkspace({
      repoPath: repo.repoPath,
      workspacePath,
      workspaceName: "ade-candidate-1",
      changeIds: [changeId],
    });
    assert.strictEqual(prepared.conflictDetail, null);
    assert.strictEqual(prepared.workspacePath, workspacePath);

    // The candidate's file is materialized in the isolated workspace, and the
    // canonical working copy is untouched.
    assert.isTrue(yield* fileSystem.exists(NodePath.join(workspacePath, "feature.txt")));
    assert.isFalse(yield* fileSystem.exists(NodePath.join(repo.repoPath, "feature.txt")));

    // No configured checks passes trivially; a red check reports its command.
    const green = yield* port.runChecks({ workspacePath, checkCommands: [] });
    assert.isTrue(green.passed);
    const stillGreen = yield* port.runChecks({
      workspacePath,
      checkCommands: ["test -f feature.txt"],
    });
    assert.isTrue(stillGreen.passed);
    const red = yield* port.runChecks({
      workspacePath,
      checkCommands: ["echo boom >&2; exit 3"],
    });
    assert.isFalse(red.passed);
    assert.strictEqual(red.failures[0]?.command, "echo boom >&2; exit 3");
    assert.strictEqual(red.failures[0]?.exitCode, 3);
    assert.include(red.failures[0]?.output ?? "", "boom");

    // Canonical advancement is the single durable commit point.
    const advanced = yield* port.advanceCanonical({
      repoPath: repo.repoPath,
      headRevision: changeId,
    });
    assert.isAbove(advanced.canonicalCommitId.length, 0);
    const canonicalDescription = yield* repo.jj([
      "log",
      "--no-graph",
      "-r",
      '"main"',
      "-T",
      'description ++ "\\n"',
    ]);
    assert.include(canonicalDescription, "candidate feature.txt");

    // Cleanup is re-runnable: the workspace is forgotten and removed, and a
    // second pass over an already-clean state still succeeds.
    yield* port.cleanupWorkspace({
      repoPath: repo.repoPath,
      workspacePath,
      workspaceName: "ade-candidate-1",
    });
    assert.isFalse(yield* fileSystem.exists(workspacePath));
    const workspaces = yield* repo.jj(["workspace", "list"]);
    assert.notInclude(workspaces, "ade-candidate-1");
    yield* port.cleanupWorkspace({
      repoPath: repo.repoPath,
      workspacePath,
      workspaceName: "ade-candidate-1",
    });
  }),
);

runtime("re-preparing a candidate resets its workspace from canonical", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const port = yield* AdeIntegrationRepoPort;
    const repo = yield* makeRepo;
    const changeId = yield* makeCandidateChange(repo, "feature.txt", "feature\n");
    const workspacePath = NodePath.join(repo.root, "work", "candidate-rerun");

    yield* port.prepareCandidateWorkspace({
      repoPath: repo.repoPath,
      workspacePath,
      workspaceName: "ade-candidate-rerun",
      changeIds: [changeId],
    });
    // Simulate debris left by a killed pass.
    yield* fileSystem.writeFileString(NodePath.join(workspacePath, "debris.txt"), "junk\n");

    const second = yield* port.prepareCandidateWorkspace({
      repoPath: repo.repoPath,
      workspacePath,
      workspaceName: "ade-candidate-rerun",
      changeIds: [changeId],
    });
    assert.strictEqual(second.conflictDetail, null);
    assert.isFalse(yield* fileSystem.exists(NodePath.join(workspacePath, "debris.txt")));
    assert.isTrue(yield* fileSystem.exists(NodePath.join(workspacePath, "feature.txt")));

    yield* port.cleanupWorkspace({
      repoPath: repo.repoPath,
      workspacePath,
      workspaceName: "ade-candidate-rerun",
    });
  }),
);

runtime("reports a rebase conflict instead of failing the pass", () =>
  Effect.gen(function* () {
    const port = yield* AdeIntegrationRepoPort;
    const repo = yield* makeRepo;

    // Two changes edit the same line off the same base; landing one makes the
    // other conflict when it is rebased onto the advanced canonical.
    const first = yield* makeCandidateChange(repo, "base.txt", "first edit\n");
    const second = yield* makeCandidateChange(repo, "base.txt", "second edit\n");
    yield* port.advanceCanonical({ repoPath: repo.repoPath, headRevision: first });

    const workspacePath = NodePath.join(repo.root, "work", "candidate-conflict");
    const prepared = yield* port.prepareCandidateWorkspace({
      repoPath: repo.repoPath,
      workspacePath,
      workspaceName: "ade-candidate-conflict",
      changeIds: [second],
    });
    assert.isNotNull(prepared.conflictDetail);

    yield* port.cleanupWorkspace({
      repoPath: repo.repoPath,
      workspacePath,
      workspaceName: "ade-candidate-conflict",
    });
  }),
);

runtime("treats a project with no remote as a documented no-op sync", () =>
  Effect.gen(function* () {
    const port = yield* AdeIntegrationRepoPort;
    const repo = yield* makeRepo;
    const synced = yield* port.syncUpstream({ repoPath: repo.repoPath, remote: null });
    assert.deepEqual(synced, { advanced: false, conflictDetail: null });
  }),
);
