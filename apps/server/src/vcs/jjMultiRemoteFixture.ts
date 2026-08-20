import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import type * as VcsDriver from "./VcsDriver.ts";

/**
 * Deterministic two-remote Jujutsu fixture used by real-`jj` regression tests.
 *
 * Starting from a freshly `jj git init`'d workspace (no remotes, no bookmarks),
 * {@link createJjTwoRemoteFixture} always produces:
 *
 * | Concern | Setup |
 * | --- | --- |
 * | Remotes | Bare Git repos `<root>/alpha.git` and `<root>/beta.git`, added as `alpha` and `beta`. There is no `origin`, so neither remote is primary. |
 * | Bookmark | Local `main` at the initial described commit. |
 * | Tracking | `main` is pushed to `alpha`, copied onto `beta` (`main:main`), fetched, tracked (`bookmark track main --remote beta`), and pushed to `beta`. Both remotes therefore have the same `main` commit and local `main` tracks both. |
 * | Mutability | `revset-aliases."immutable_heads()"` is `none()`, so later `bookmark set --allow-backwards` moves are allowed. |
 * | Conflicts | Working copy is clean and agrees with `main`. Divergence is **not** created here; call {@link advanceBareRemoteBranch} then a local commit to manufacture behind/divergent state. |
 */
export const JJ_TWO_REMOTE_NAMES = ["alpha", "beta"] as const;
export const JJ_TWO_REMOTE_BOOKMARK = "main";

export type JjTwoRemoteName = (typeof JJ_TWO_REMOTE_NAMES)[number];

export interface JjTwoRemoteFixtureOps {
  readonly status: NonNullable<VcsDriver.VcsDriver["Service"]["status"]>;
  readonly createRef: NonNullable<VcsDriver.VcsDriver["Service"]["createRef"]>;
  readonly describeChange: NonNullable<VcsDriver.VcsDriver["Service"]["describeChange"]>;
  readonly fetch: NonNullable<VcsDriver.VcsDriver["Service"]["fetch"]>;
  readonly pushBookmark: NonNullable<VcsDriver.VcsDriver["Service"]["pushBookmark"]>;
}

export interface CreateJjTwoRemoteFixtureInput {
  readonly cwd: string;
  readonly root: string;
  readonly driver: VcsDriver.VcsDriver["Service"];
  readonly ops: JjTwoRemoteFixtureOps;
}

export interface JjTwoRemoteFixture {
  readonly bookmarkName: typeof JJ_TWO_REMOTE_BOOKMARK;
  readonly remoteNames: typeof JJ_TWO_REMOTE_NAMES;
  readonly initialCommitId: string;
  readonly alphaGitDir: string;
  readonly betaGitDir: string;
}

const git = (args: ReadonlyArray<string>): void => {
  NodeChildProcess.execFileSync("git", [...args], { stdio: "ignore" });
};

const configureGitIdentity = (cwd: string): void => {
  git(["-C", cwd, "config", "user.name", "JJ Test"]);
  git(["-C", cwd, "config", "user.email", "jj@test.invalid"]);
};

export const createJjTwoRemoteFixture = Effect.fn("createJjTwoRemoteFixture")(function* (
  input: CreateJjTwoRemoteFixtureInput,
) {
  const { cwd, root, driver, ops } = input;
  const alphaGitDir = NodePath.join(root, "alpha.git");
  const betaGitDir = NodePath.join(root, "beta.git");

  for (const remoteName of JJ_TWO_REMOTE_NAMES) {
    const remotePath = NodePath.join(root, `${remoteName}.git`);
    git(["init", "--bare", remotePath]);
    yield* driver.execute({
      operation: `JjVcsDriver.runtime.addRemote.${remoteName}`,
      cwd,
      args: ["git", "remote", "add", remoteName, remotePath],
    });
  }

  NodeFS.writeFileSync(NodePath.join(cwd, "ambiguous.txt"), "ambiguous\n");
  yield* ops.describeChange({ cwd, description: "ambiguous remote" });
  yield* ops.createRef({ cwd, refName: JJ_TWO_REMOTE_BOOKMARK });
  const initialCommitId = (yield* ops.status({ cwd })).workingCopy?.commitId;
  if (initialCommitId === undefined || initialCommitId.length === 0) {
    throw new Error("JJ two-remote fixture failed to record the initial commit");
  }

  yield* ops.pushBookmark({
    cwd,
    bookmarkName: JJ_TWO_REMOTE_BOOKMARK,
    remoteName: "alpha",
  });
  git(["--git-dir", betaGitDir, "fetch", alphaGitDir, "main:main"]);
  yield* driver.execute({
    operation: "JjVcsDriver.runtime.allowCurrentMultiRemoteBookmark",
    cwd,
    args: ["config", "set", "--repo", 'revset-aliases."immutable_heads()"', "none()"],
  });
  yield* ops.fetch({ cwd, remoteName: "beta" });
  yield* driver.execute({
    operation: "JjVcsDriver.runtime.trackBeta",
    cwd,
    args: ["bookmark", "track", JJ_TWO_REMOTE_BOOKMARK, "--remote", "beta"],
  });
  yield* ops.pushBookmark({
    cwd,
    bookmarkName: JJ_TWO_REMOTE_BOOKMARK,
    remoteName: "beta",
  });

  return {
    bookmarkName: JJ_TWO_REMOTE_BOOKMARK,
    remoteNames: JJ_TWO_REMOTE_NAMES,
    initialCommitId,
    alphaGitDir,
    betaGitDir,
  } satisfies JjTwoRemoteFixture;
});

export const advanceBareRemoteBranch = (input: {
  readonly root: string;
  readonly gitDir: string;
  readonly cloneName: string;
  readonly branchName: string;
  readonly relativeFile: string;
  readonly appendText: string;
  readonly commitMessage: string;
}): void => {
  const clonePath = NodePath.join(input.root, input.cloneName);
  git(["clone", "--branch", input.branchName, input.gitDir, clonePath]);
  configureGitIdentity(clonePath);
  NodeFS.appendFileSync(NodePath.join(clonePath, input.relativeFile), input.appendText);
  git(["-C", clonePath, "add", input.relativeFile]);
  git(["-C", clonePath, "commit", "-m", input.commitMessage]);
  git(["-C", clonePath, "push", "origin", input.branchName]);
};
