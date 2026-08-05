// @effect-diagnostics nodeBuiltinImport:off - builds real worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import {
  resolveGitWorktreePath,
  resolveJjWorkspacePath,
  resolveWorktreeShuv2CodeHome,
} from "./devHome.ts";

const makeRepo = (
  kind:
    | "worktree"
    | "checkout"
    | "bare"
    | "submodule"
    | "unreadable-git-file"
    | "bare-repo-worktree"
    | "custom-common-dir-worktree"
    | "jj-workspace"
    | "jj-default",
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shuv2code-devhome-"));
      if (kind === "worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
      } else if (kind === "bare-repo-worktree") {
        // `git worktree add` from a bare repo: the common dir is `<name>.git`.
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /srv/myrepo.git/worktrees/x\n");
      } else if (kind === "custom-common-dir-worktree") {
        // $GIT_COMMON_DIR need not be named `.git` at all.
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /srv/store/worktrees/x\n");
      } else if (kind === "submodule") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: ../.git/modules/sub\n");
      } else if (kind === "unreadable-git-file") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "not a gitdir pointer\n");
      } else if (kind === "checkout") {
        NodeFS.mkdirSync(NodePath.join(root, ".git"));
      } else if (kind === "jj-workspace") {
        NodeFS.mkdirSync(NodePath.join(root, ".jj"));
        NodeFS.writeFileSync(NodePath.join(root, ".jj", "repo"), "../../source/.jj/repo\n");
      } else if (kind === "jj-default") {
        NodeFS.mkdirSync(NodePath.join(root, ".jj", "repo"), { recursive: true });
      }
      const nested = NodePath.join(root, "apps", "web", "src");
      NodeFS.mkdirSync(nested, { recursive: true });
      return { root, nested };
    }),
    ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

describe("resolveGitWorktreePath", () => {
  it.effect("finds a worktree root from a nested directory", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a main checkout as not a linked worktree", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("checkout");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a directory outside a repository", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("bare");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a submodule as not a linked worktree", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("submodule");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a .git file without a usable gitdir pointer", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("unreadable-git-file");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a worktree of a bare repository", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("bare-repo-worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a worktree whose common dir is not named .git", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("custom-common-dir-worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("resolveJjWorkspacePath", () => {
  it.effect("finds a linked JJ workspace from a nested directory", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("jj-workspace");
      assert.equal(yield* resolveJjWorkspacePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not classify the default JJ workspace as linked", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("jj-default");
      assert.equal(yield* resolveJjWorkspacePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("resolveWorktreeShuv2CodeHome", () => {
  it.effect("answers with .shuv2code before the dev runner creates it", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      const home = yield* resolveWorktreeShuv2CodeHome(nested);
      assert.equal(home, NodePath.join(NodePath.resolve(root), ".shuv2code"));
      assert.isFalse(NodeFS.existsSync(home ?? ""));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses isolated state for a linked JJ workspace", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("jj-workspace");
      assert.equal(
        yield* resolveWorktreeShuv2CodeHome(nested),
        NodePath.join(NodePath.resolve(root), ".shuv2code"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
