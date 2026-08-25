// @effect-diagnostics nodeBuiltinImport:off - exercises a disposable on-disk JJ repository.
/**
 * Real-`jj` coverage for the publication service's mechanics half (spec §4.5,
 * ADR §8, §14.5; spike #134). The state machine is covered against a stub port
 * in `AdePublicationService.test.ts`; this file proves the operations behind it
 * actually behave the way the binding invariants claim.
 *
 * **What is real and what is mocked.** The JJ side is entirely real: a
 * disposable colocated repository with a real bare Git remote, driven by the
 * real `jj` binary through the ordinary `JjVcsDriver` seam. Nothing about
 * bookmarks, fetching, pushing, ancestry, or `--skip-emptied` is simulated —
 * these tests would catch a jj behaviour change. GitHub is mocked at the
 * `GitHubCli` service boundary (the house style, per `GitHubCli.test.ts` and
 * `GitHubPullRequestCli.test.ts`), because there is no scratch GitHub account
 * in CI; the mock replays recorded `gh --json` payloads and records argv so the
 * *command construction* is still asserted for real.
 *
 * The four invariants issue #165 names are covered here as:
 *
 * - out-of-band branch deletion is repaired **only after** a fetch → "a push
 *   alone does not repair an out-of-band deletion; a fetch does";
 * - replacement-PR representation → "adopts the pull request GitHub currently
 *   shows for a head branch";
 * - post-merge reconciliation keys on SHAs → "detects landing by SHA, not by
 *   branch name or change id";
 * - workspace tree hash unchanged → "a publish pass writes nothing into the
 *   workspace it operates on".
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { AdePublicationRepoPort, layer as repoPortLayer } from "./AdePublicationRepoPort.ts";

// ---------------------------------------------------------------------------
// The mocked GitHub half
// ---------------------------------------------------------------------------

/** A quoted revset literal, mirroring the port's own escaping. */
const revsetOf = (value: string) => `"${value}"`;

interface GhCall {
  readonly args: ReadonlyArray<string>;
}

interface GhState {
  /** Replies keyed by a substring the argv must contain, first match wins. */
  readonly replies: ReadonlyArray<{ readonly match: string; readonly stdout: string }>;
  readonly calls: ReadonlyArray<GhCall>;
}

const makeGhStub = Effect.gen(function* () {
  const state = yield* Ref.make<GhState>({ replies: [], calls: [] });

  const execute: GitHubCli.GitHubCli["Service"]["execute"] = (input) =>
    Effect.gen(function* () {
      const current = yield* Ref.updateAndGet(state, (value) => ({
        ...value,
        calls: [...value.calls, { args: input.args }],
      }));
      const joined = input.args.join(" ");
      const reply = current.replies.find((candidate) => joined.includes(candidate.match));
      return {
        exitCode: 0 as VcsProcess.VcsProcessOutput["exitCode"],
        stdout: reply?.stdout ?? "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      } satisfies VcsProcess.VcsProcessOutput;
    });

  return { state, layer: Layer.mock(GitHubCli.GitHubCli)({ execute }) };
});

/** The real half: the actual `jj` binary behind the ordinary driver seam. */
const BaseLayer = JjVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

// ---------------------------------------------------------------------------
// A disposable colocated repository with a real bare Git remote
// ---------------------------------------------------------------------------

interface Repo {
  readonly repoPath: string;
  readonly remotePath: string;
  readonly root: string;
  readonly jj: (args: ReadonlyArray<string>) => Effect.Effect<string, never, VcsDriver.VcsDriver>;
  readonly git: (args: ReadonlyArray<string>) => Effect.Effect<string, never, VcsDriver.VcsDriver>;
}

const makeRepo = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const driver = yield* VcsDriver.VcsDriver;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "shuv2code-ade-publication-" });
  const repoPath = NodePath.join(root, "repo");
  const remotePath = NodePath.join(root, "remote.git");
  yield* fileSystem.makeDirectory(repoPath);
  yield* fileSystem.makeDirectory(remotePath);

  const git = (args: ReadonlyArray<string>) =>
    runner.run({ command: "git", args: [...args], cwd: root, timeout: 60_000 }).pipe(
      Effect.map((result) => `${result.stdout}${result.stderr}`),
      Effect.orDie,
    );

  yield* git(["init", "--bare", "-q", remotePath]);
  yield* driver.initRepository({ cwd: repoPath, kind: "jj" });

  const jj = (args: ReadonlyArray<string>) =>
    driver
      .execute({
        operation: "AdePublicationRepoPort.test",
        cwd: repoPath,
        args,
        allowNonZeroExit: true,
        timeoutMs: 120_000,
      })
      .pipe(
        Effect.map((result) => `${result.stdout}${result.stderr}`),
        Effect.orDie,
      );

  yield* jj(["config", "set", "--repo", "user.name", "ADE Test"]);
  yield* jj(["config", "set", "--repo", "user.email", "ade@test.invalid"]);
  yield* jj(["config", "set", "--repo", "revset-aliases.immutable_heads()", "none()"]);
  yield* jj(["git", "remote", "add", "origin", remotePath]);

  yield* fileSystem.writeFileString(NodePath.join(repoPath, "base.txt"), "base\n");
  yield* jj(["describe", "-m", "base"]);
  yield* jj(["bookmark", "set", "main", "--revision", "@", "--allow-backwards"]);
  yield* jj(["git", "push", "--remote", "origin", "--bookmark", "exact:main"]);

  return { repoPath, remotePath, root, jj, git } satisfies Repo;
});

/** Create a described change off `main` and park `@` on a child of it. */
const makeLayerChange = (repo: Repo, fileName: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* repo.jj(["new", '"main"']);
    yield* fileSystem.writeFileString(NodePath.join(repo.repoPath, fileName), contents);
    yield* repo.jj(["describe", "-m", `layer ${fileName}`]);
    const changeId = (yield* repo.jj(["log", "--no-graph", "-r", "@", "-T", 'change_id ++ "\\n"']))
      .trim()
      .split("\n")[0] as string;
    // Park `@` on an empty child: publication must never need to edit a layer,
    // and two workspaces may not sit on the same commit.
    yield* repo.jj(["new"]);
    return changeId;
  });

const remoteRefs = (repo: Repo) =>
  repo
    .git(["--git-dir", repo.remotePath, "for-each-ref", "--format=%(refname)"])
    .pipe(Effect.map((output) => output.trim().split("\n").filter(Boolean)));

/**
 * A content hash of the working copy, ignoring the VCS metadata directories.
 * This is the direct evidence for spec §4.5 invariant 4: a publish pass must
 * leave it byte-identical.
 */
const workingCopyHash = (repoPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const hash = NodeCrypto.createHash("sha256");
    const walk = (dir: string, prefix: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const entries = yield* Effect.orDie(fileSystem.readDirectory(dir));
        for (const entry of [...entries].sort()) {
          if (entry === ".jj" || entry === ".git") continue;
          const full = NodePath.join(dir, entry);
          const info = yield* Effect.orDie(fileSystem.stat(full));
          if (info.type === "Directory") {
            yield* walk(full, `${prefix}${entry}/`);
            continue;
          }
          hash.update(`${prefix}${entry}\0`);
          hash.update(yield* Effect.orDie(fileSystem.readFile(full)));
        }
      });
    yield* walk(repoPath, "");
    return hash.digest("hex");
  });

const runtime = <A, E>(
  name: string,
  body: (
    gh: Ref.Ref<GhState>,
  ) => Effect.Effect<
    A,
    E,
    | AdePublicationRepoPort
    | VcsDriver.VcsDriver
    | ProcessRunner.ProcessRunner
    | FileSystem.FileSystem
    | Scope.Scope
  >,
) =>
  it.effect(
    name,
    () =>
      Effect.gen(function* () {
        const gh = yield* makeGhStub;
        // The port is built over the mocked GitHub service and the *real* jj
        // driver from `BaseLayer` — the real/mocked split this file documents.
        return yield* body(gh.state).pipe(
          Effect.provide(repoPortLayer.pipe(Layer.provide(gh.layer))),
        );
      }).pipe(Effect.scoped, Effect.provide(BaseLayer)),
    { timeout: 180_000 },
  );

// ---------------------------------------------------------------------------
// Invariant 1 — converge-then-act
// ---------------------------------------------------------------------------

runtime("a push alone does not repair an out-of-band deletion; a fetch does", () =>
  Effect.gen(function* () {
    const port = yield* AdePublicationRepoPort;
    const repo = yield* makeRepo;
    const changeId = yield* makeLayerChange(repo, "layer-a.txt", "a\n");
    const bookmarkName = "ade/pub/deadbeef/0000";

    const placed = yield* port.ensureBookmark({
      repoPath: repo.repoPath,
      bookmarkName,
      changeId,
    });
    assert.isTrue(placed.recreated);
    yield* port.pushBookmarks({
      repoPath: repo.repoPath,
      remote: "origin",
      bookmarkNames: [bookmarkName],
    });
    assert.include(yield* remoteRefs(repo), `refs/heads/${bookmarkName}`);
    const publishedSha = placed.headSha;

    // Somebody deletes the branch on the forge, exactly as the spike's P3b did.
    yield* repo.git([
      "--git-dir",
      repo.remotePath,
      "update-ref",
      "-d",
      `refs/heads/${bookmarkName}`,
    ]);
    assert.notInclude(yield* remoteRefs(repo), `refs/heads/${bookmarkName}`);

    // Re-publishing WITHOUT converging first repairs nothing: jj compares
    // against its last-fetched view of the remote, sees "already matches", and
    // pushes no refs. This is precisely why invariant 1 exists, and asserting
    // it is what stops a future refactor from dropping the fetch.
    yield* port.ensureBookmark({ repoPath: repo.repoPath, bookmarkName, changeId });
    yield* port.pushBookmarks({
      repoPath: repo.repoPath,
      remote: "origin",
      bookmarkNames: [bookmarkName],
    });
    assert.notInclude(
      yield* remoteRefs(repo),
      `refs/heads/${bookmarkName}`,
      "a push without a preceding fetch must not be able to repair the branch",
    );

    // Converge. The fetch imports the deletion, which also removes the local
    // bookmark — so the durable change id is the only thing left to rebuild from.
    yield* port.fetch({ repoPath: repo.repoPath, remote: "origin" });
    assert.strictEqual(
      yield* port.readBookmarkSha({ repoPath: repo.repoPath, bookmarkName }),
      null,
      "the fetch must delete the local bookmark whose remote branch is gone",
    );

    const repaired = yield* port.ensureBookmark({
      repoPath: repo.repoPath,
      bookmarkName,
      changeId,
    });
    assert.isTrue(repaired.recreated);
    // Same SHA: this is what keeps a cascade-closed PR reopenable rather than
    // forcing a replacement (spike P3b vs P4).
    assert.strictEqual(repaired.headSha, publishedSha);
    yield* port.pushBookmarks({
      repoPath: repo.repoPath,
      remote: "origin",
      bookmarkNames: [bookmarkName],
    });
    assert.include(yield* remoteRefs(repo), `refs/heads/${bookmarkName}`);
  }),
);

// ---------------------------------------------------------------------------
// Invariant 2 — mutable prNumber, adopt-by-head-branch
// ---------------------------------------------------------------------------

runtime("adopts the pull request GitHub currently shows for a head branch", (gh) =>
  Effect.gen(function* () {
    const port = yield* AdePublicationRepoPort;
    const repo = yield* makeRepo;
    const bookmarkName = "ade/pub/deadbeef/0001";

    // The replacement shape from the spike: PR #2 was cascade-closed when its
    // branch was deleted, reopening failed because the head came back at a
    // different SHA, and #4 was minted for the same branch. Both PRs are still
    // reported by `gh pr list --head`, so the reader must prefer the live one.
    yield* Ref.set(gh, {
      calls: [],
      replies: [
        {
          match: `--head ${bookmarkName}`,
          // Recorded `gh pr list --json ...` output, kept as the raw text `gh`
          // actually prints so the decoder is exercised against the real shape.
          // The third entry is a PR on a *different* branch that `gh` matched
          // loosely; it must never be adopted onto this layer.
          stdout: `[
            {"number":2,"headRefName":"${bookmarkName}","baseRefName":"main",
             "state":"CLOSED","isDraft":false,
             "headRefOid":"1111111111111111111111111111111111111111","mergeCommit":null},
            {"number":4,"headRefName":"${bookmarkName}","baseRefName":"main",
             "state":"OPEN","isDraft":true,
             "headRefOid":"2222222222222222222222222222222222222222","mergeCommit":null},
            {"number":9,"headRefName":"${bookmarkName}-suffix","baseRefName":"main",
             "state":"OPEN","isDraft":false,
             "headRefOid":"3333333333333333333333333333333333333333","mergeCommit":null}
          ]`,
        },
      ],
    });

    const found = yield* port.readPullRequestsByHeadBranch({
      repoPath: repo.repoPath,
      bookmarkNames: [bookmarkName],
    });
    assert.deepEqual(
      found.map((pr) => pr.number),
      [2, 4],
      "the loosely-matched foreign branch must be filtered out",
    );
    assert.strictEqual(found.find((pr) => pr.number === 4)?.state, "open");
    assert.strictEqual(found.find((pr) => pr.number === 2)?.state, "closed");

    // The read is unconditional and covers every state: a cascade-closed PR is
    // the state the repair path needs to see, so `--state open` would blind it.
    const call = (yield* Ref.get(gh)).calls[0];
    assert.deepInclude(call?.args ?? [], "--state");
    assert.deepInclude(call?.args ?? [], "all");
    assert.deepInclude(call?.args ?? [], "--head");
    assert.deepInclude(call?.args ?? [], bookmarkName);
    assert.include(
      (call?.args ?? []).join(" "),
      "mergeCommit",
      "the merge SHA reconciliation keys on must be requested",
    );

    // A merged PR wins over an open one, because only it carries a merge SHA.
    yield* Ref.update(gh, (state) => ({
      ...state,
      replies: [
        {
          match: `--head ${bookmarkName}`,
          stdout: `[
            {"number":4,"headRefName":"${bookmarkName}","baseRefName":"main",
             "state":"MERGED","isDraft":false,
             "headRefOid":"2222222222222222222222222222222222222222",
             "mergeCommit":{"oid":"4444444444444444444444444444444444444444"}}
          ]`,
        },
      ],
    }));
    const merged = yield* port.readPullRequestsByHeadBranch({
      repoPath: repo.repoPath,
      bookmarkNames: [bookmarkName],
    });
    assert.strictEqual(merged[0]?.state, "merged");
    assert.strictEqual(merged[0]?.mergeSha, "4444444444444444444444444444444444444444");
  }),
);

runtime("never passes --delete-branch, and merges the stack non-interactively", (gh) =>
  Effect.gen(function* () {
    const port = yield* AdePublicationRepoPort;
    const repo = yield* makeRepo;

    yield* port.mergeStack({ repoPath: repo.repoPath, stackNumber: 7, mergeMethod: "squash" });
    yield* port.mergePullRequest({ repoPath: repo.repoPath, prNumber: 4, mergeMethod: "squash" });
    yield* port.retargetPullRequest({ repoPath: repo.repoPath, prNumber: 4, baseBranch: "main" });

    const calls = (yield* Ref.get(gh)).calls;
    for (const call of calls) {
      // Spec §4.5 invariant 5: deleting a publication branch mid-stack
      // cascade-closes every dependent PR. Cleanup is a separate pass.
      assert.notInclude(call.args, "--delete-branch");
    }
    assert.deepEqual(calls[0]?.args, ["stack", "merge", "7", "--yes", "--squash"]);
    assert.deepEqual(calls[1]?.args, ["pr", "merge", "4", "--squash"]);
    assert.deepEqual(calls[2]?.args, ["pr", "edit", "4", "--base", "main"]);
  }),
);

// ---------------------------------------------------------------------------
// Invariant 3 — SHA-keyed post-merge reconciliation
// ---------------------------------------------------------------------------

runtime("detects landing by SHA, not by branch name or change id", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const port = yield* AdePublicationRepoPort;
    const repo = yield* makeRepo;

    const layerChangeId = yield* makeLayerChange(repo, "layer-b.txt", "b\n");
    const bookmarkName = "ade/pub/deadbeef/0002";
    yield* port.ensureBookmark({ repoPath: repo.repoPath, bookmarkName, changeId: layerChangeId });
    yield* port.pushBookmarks({
      repoPath: repo.repoPath,
      remote: "origin",
      bookmarkNames: [bookmarkName],
    });

    // Simulate GitHub squash-merging the layer: the same content lands on main
    // as a brand-new commit that shares no ancestry and no change id with the
    // local layer. This is the exact case where change ids and branch names
    // both stop being usable keys.
    yield* repo.jj(["new", '"main"']);
    yield* fileSystem.writeFileString(NodePath.join(repo.repoPath, "layer-b.txt"), "b\n");
    yield* repo.jj(["describe", "-m", "Squashed layer-b (#7)"]);
    yield* repo.jj(["bookmark", "set", "main", "--revision", "@", "--allow-backwards"]);
    const mergeSha = (yield* repo.jj([
      "log",
      "--no-graph",
      "-r",
      '"main"',
      "-T",
      "commit_id",
    ])).trim();
    yield* repo.jj(["new"]);
    yield* repo.jj(["git", "push", "--remote", "origin", "--bookmark", "exact:main"]);
    yield* port.fetch({ repoPath: repo.repoPath, remote: "origin" });

    // The branch is deleted on the forge, as it would be by anyone tidying up —
    // reconciliation must be unaffected, because it never keyed on the name.
    yield* repo.git([
      "--git-dir",
      repo.remotePath,
      "update-ref",
      "-d",
      `refs/heads/${bookmarkName}`,
    ]);
    yield* port.fetch({ repoPath: repo.repoPath, remote: "origin" });

    const unrelatedSha = (yield* repo.jj([
      "log",
      "--no-graph",
      "-r",
      revsetOf(layerChangeId),
      "-T",
      "commit_id",
    ])).trim();

    const landed = yield* port.landedShas({
      repoPath: repo.repoPath,
      baseBookmark: "main",
      remote: "origin",
      shas: [mergeSha, unrelatedSha],
    });
    assert.deepEqual(
      landed,
      [mergeSha],
      "only the recorded merge SHA is an ancestor of the fetched base",
    );

    // The refresh empties the local layer, because its content is already on the
    // base, and abandons it. `--skip-emptied` is what proves the equivalence.
    const refreshed = yield* port.refreshStack({
      repoPath: repo.repoPath,
      bottomChangeId: layerChangeId,
      baseBookmark: "main",
      remote: "origin",
    });
    assert.isNull(refreshed.conflictDetail);

    // Once abandoned the change id stops resolving. A second reconciliation must
    // read that as *converged*, not as a failure, or a completed stack would
    // look broken forever.
    const again = yield* port.refreshStack({
      repoPath: repo.repoPath,
      bottomChangeId: layerChangeId,
      baseBookmark: "main",
      remote: "origin",
    });
    assert.deepEqual(again, { rebased: false, conflictDetail: null });
  }),
);

// ---------------------------------------------------------------------------
// Invariant 4 — zero writes inside operated workspaces
// ---------------------------------------------------------------------------

runtime("a publish pass writes nothing into the workspace it operates on", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const port = yield* AdePublicationRepoPort;
    const repo = yield* makeRepo;
    const changeId = yield* makeLayerChange(repo, "layer-c.txt", "c\n");
    const bookmarkName = "ade/pub/deadbeef/0003";

    // The spike's hazard, reproduced: `@` sits on top of the stack and the
    // working copy carries a stray file. Any jj command that snapshots would
    // fold `scratch.txt` into `@` — silently editing work nobody asked to edit.
    yield* fileSystem.writeFileString(NodePath.join(repo.repoPath, "scratch.txt"), "not ours\n");

    const beforeHash = yield* workingCopyHash(repo.repoPath);
    const beforeFingerprint = yield* port.workingCopyFingerprint({ repoPath: repo.repoPath });

    yield* port.fetch({ repoPath: repo.repoPath, remote: "origin" });
    yield* port.ensureBookmark({ repoPath: repo.repoPath, bookmarkName, changeId });
    yield* port.pushBookmarks({
      repoPath: repo.repoPath,
      remote: "origin",
      bookmarkNames: [bookmarkName],
    });
    yield* port.landedShas({
      repoPath: repo.repoPath,
      baseBookmark: "main",
      remote: "origin",
      shas: [],
    });
    yield* port.readBookmarkSha({ repoPath: repo.repoPath, bookmarkName });

    const afterHash = yield* workingCopyHash(repo.repoPath);
    const afterFingerprint = yield* port.workingCopyFingerprint({ repoPath: repo.repoPath });

    assert.strictEqual(afterHash, beforeHash, "the operated working copy was written to");
    assert.strictEqual(
      afterFingerprint.commitId,
      beforeFingerprint.commitId,
      "the pass moved or rewrote the working-copy commit",
    );

    // And the stray file was never absorbed: `@` is still empty.
    const isEmpty = yield* repo.jj([
      "log",
      "--no-graph",
      "--ignore-working-copy",
      "-r",
      "@",
      "-T",
      'if(empty, "empty", "dirty")',
    ]);
    assert.include(isEmpty, "empty");
  }),
);

// ---------------------------------------------------------------------------
// Argument hardening (the S10 review lesson, applied up front)
// ---------------------------------------------------------------------------

runtime("refuses refs, change ids, and SHAs that are really revsets or flags", () =>
  Effect.gen(function* () {
    const port = yield* AdePublicationRepoPort;
    const repo = yield* makeRepo;
    const changeId = yield* makeLayerChange(repo, "layer-d.txt", "d\n");
    const before = yield* remoteRefs(repo);

    // `--bookmark` globs by default, so a name carrying `*` would publish
    // branches nobody asked for; `..` and a leading `-` are the Git and argv
    // escapes. None of them may reach `jj`.
    for (const hostile of ["ade/pub/*", "--force", "a..b", "refs//x", "@", ""]) {
      const refused = yield* port
        .ensureBookmark({ repoPath: repo.repoPath, bookmarkName: hostile, changeId })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "AdePublicationRepoError");
    }
    for (const hostile of ["all()", "--help", "root()"]) {
      const refused = yield* port
        .ensureBookmark({ repoPath: repo.repoPath, bookmarkName: "ade/pub/ok", changeId: hostile })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "AdePublicationRepoError");
    }
    // Recorded SHAs are interpolated into ancestry revsets, so a "SHA" that is
    // really a revset would turn a landing probe into arbitrary selection.
    const refusedSha = yield* port
      .landedShas({
        repoPath: repo.repoPath,
        baseBookmark: "main",
        remote: "origin",
        shas: ["all()"],
      })
      .pipe(Effect.flip);
    assert.strictEqual(refusedSha._tag, "AdePublicationRepoError");

    assert.deepEqual(
      yield* remoteRefs(repo),
      before,
      "a refused argument still mutated the remote",
    );
  }),
);
