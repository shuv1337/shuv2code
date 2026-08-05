// @effect-diagnostics nodeBuiltinImport:off - exercises disposable on-disk Git repositories.
/* oxlint-disable shuv2code/no-manual-effect-runtime-in-tests -- Independent runtime probe while the Effect/Vite+ adapter fails before collection. */
import * as NodeServices from "@effect/platform-node/NodeServices";
// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const TestLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "shuv2code-git-runtime-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it("retains Git status, branch, and worktree semantics behind the generalized contracts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "shuv2code-git-runtime-" });
      const cwd = NodePath.join(root, "repo");
      yield* fileSystem.makeDirectory(cwd);
      const git = yield* GitVcsDriver.GitVcsDriver;

      yield* git.initRepo({ cwd, kind: "git" });
      yield* git.execute({
        operation: "git-test-email",
        cwd,
        args: ["config", "user.email", "git@test.invalid"],
      });
      yield* git.execute({
        operation: "git-test-name",
        cwd,
        args: ["config", "user.name", "Git Test"],
      });
      NodeFS.writeFileSync(NodePath.join(cwd, "tracked.txt"), "tracked\n");
      yield* git.execute({ operation: "git-test-add", cwd, args: ["add", "tracked.txt"] });
      yield* git.execute({ operation: "git-test-commit", cwd, args: ["commit", "-m", "base"] });

      const status = yield* git.status({ cwd });
      expect(status.kind).toBe("git");
      expect(status.capabilities).toEqual(GitVcsDriver.GIT_VCS_CAPABILITIES);
      expect(status.workingCopy).toBe(null);
      expect(status.refName).toBeTruthy();

      yield* git.createRef({ cwd, refName: "feature/generalized", switchRef: true });
      expect((yield* git.status({ cwd })).refName).toBe("feature/generalized");
      const refs = yield* git.listRefs({ cwd, refKind: "local" });
      expect(refs.refs.find((ref) => ref.name === "feature/generalized")).toMatchObject({
        kind: "branch",
        current: true,
      });

      const worktreePath = NodePath.join(root, "exact-worktree");
      yield* git.createWorktree({
        cwd,
        refName: "feature/generalized",
        newRefName: "feature/worktree",
        path: worktreePath,
      });
      expect(NodeFS.existsSync(NodePath.join(worktreePath, ".git"))).toBe(true);
      yield* git.removeWorktree({ cwd, path: worktreePath, force: true });
      expect(NodeFS.existsSync(worktreePath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  ));
