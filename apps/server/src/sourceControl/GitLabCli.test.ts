import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import { VcsProcessExitError } from "@shuv2code/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabCli from "./GitLabCli.ts";

const mockedRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: mockedRun,
      }),
    ),
  ),
);

function processOutput(stdout: string): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

afterEach(() => {
  mockedRun.mockReset();
});

layer("GitLabCli.layer", (it) => {
  it.effect("parses merge request view output", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              iid: 42,
              title: "Add MR thread creation",
              web_url: "https://gitlab.com/shuv1337/shuv2code/-/merge_requests/42",
              target_branch: "main",
              source_branch: "feature/mr-threads",
              state: "opened",
              source_project_id: 101,
              target_project_id: 100,
              source_project: {
                path_with_namespace: "octocat/shuv2code",
              },
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add MR thread creation",
        url: "https://gitlab.com/shuv1337/shuv2code/-/merge_requests/42",
        baseRefName: "main",
        headRefName: "feature/mr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/shuv2code",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "view", "42", "--output", "json"],
        }),
      );
    }),
  );

  it.effect("skips invalid entries when parsing MR lists", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                iid: 0,
                title: "invalid",
                web_url: "https://gitlab.com/shuv1337/shuv2code/-/merge_requests/0",
                target_branch: "main",
                source_branch: "feature/invalid",
              },
              {
                iid: 43,
                title: "  Valid MR  ",
                web_url: " https://gitlab.com/shuv1337/shuv2code/-/merge_requests/43 ",
                target_branch: " main ",
                source_branch: " feature/mr-list ",
                state: "merged",
              },
            ]),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature/mr-list",
          state: "all",
        });
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid MR",
          url: "https://gitlab.com/shuv1337/shuv2code/-/merge_requests/43",
          baseRefName: "main",
          headRefName: "feature/mr-list",
          state: "merged",
        },
      ]);
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "mr",
            "list",
            "--source-branch",
            "feature/mr-list",
            "--all",
            "--per-page",
            "20",
            "--output",
            "json",
          ],
        }),
      );
    }),
  );

  it.effect("filters merge requests by the exact fork source repository", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                iid: 44,
                title: "Other fork",
                web_url: "https://gitlab.com/upstream/project/-/merge_requests/44",
                target_branch: "main",
                source_branch: "feature/shared",
                state: "opened",
                source_project: { path_with_namespace: "other/project" },
              },
              {
                iid: 45,
                title: "Selected fork",
                web_url: "https://gitlab.com/upstream/project/-/merge_requests/45",
                target_branch: "main",
                source_branch: "feature/shared",
                state: "opened",
                source_project: { path_with_namespace: "selected/project" },
              },
            ]),
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.listMergeRequests({
        cwd: "/repo",
        headSelector: "feature/shared",
        source: { refName: "feature/shared", repository: "selected/project" },
        target: { refName: "main", repository: "upstream/project" },
        state: "open",
        limit: 100,
      });

      assert.deepStrictEqual(
        result.map((item) => item.number),
        [45],
      );
    }),
  );

  it.effect("fails closed when a fork lookup omits source identity", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                iid: 46,
                title: "Missing source identity",
                web_url: "https://gitlab.com/upstream/project/-/merge_requests/46",
                target_branch: "main",
                source_branch: "feature/shared",
                state: "opened",
              },
            ]),
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .listMergeRequests({
          cwd: "/repo",
          headSelector: "feature/shared",
          source: { refName: "feature/shared", repository: "selected/project" },
          state: "open",
          limit: 100,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, GitLabCli.GitLabCliCommandError);
    }),
  );

  it.effect("fails closed when exact fork filtering saturates the candidate limit", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify(
              [47, 48].map((iid) => ({
                iid,
                title: `Other fork ${iid}`,
                web_url: `https://gitlab.com/upstream/project/-/merge_requests/${iid}`,
                target_branch: "main",
                source_branch: "feature/shared",
                state: "opened",
                source_project: { path_with_namespace: `other-${iid}/project` },
              })),
            ),
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .listMergeRequests({
          cwd: "/repo",
          headSelector: "feature/shared",
          source: { refName: "feature/shared", repository: "selected/project" },
          state: "open",
          limit: 2,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, GitLabCli.GitLabCliCommandError);
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              path_with_namespace: "octocat/shuv2code",
              web_url: "https://gitlab.com/octocat/shuv2code",
              http_url_to_repo: "https://gitlab.com/octocat/shuv2code.git",
              ssh_url_to_repo: "git@gitlab.com:octocat/shuv2code.git",
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/shuv2code",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/shuv2code",
        url: "https://gitlab.com/octocat/shuv2code",
        sshUrl: "git@gitlab.com:octocat/shuv2code.git",
      });
    }),
  );

  it.effect("creates merge requests through the GitLab API without placing the body in argv", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "owner:feature/provider",
        title: "Provider MR",
        bodyFile: "/tmp/shuv2code-mr-body.md",
      });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects/:fullpath/merge_requests",
            "--raw-field",
            "source_branch=feature/provider",
            "--raw-field",
            "target_branch=main",
            "--raw-field",
            "title=Provider MR",
            "--field",
            "description=@/tmp/shuv2code-mr-body.md",
          ],
        }),
      );
    }),
  );

  it.effect("uses explicit GitLab repository coordinates instead of cwd detection", () =>
    Effect.gen(function* () {
      mockedRun
        .mockReturnValueOnce(Effect.succeed(processOutput("[]")))
        .mockReturnValueOnce(Effect.succeed(processOutput("{}")))
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({ default_branch: "develop" }),
            ),
          ),
        );

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.listMergeRequests({
        cwd: "/repo",
        repository: "https://gitlab.example.test/example/selected",
        headSelector: "feature/provider",
        target: { refName: "release", repository: "ignored/other" },
        state: "open",
        limit: 1,
      });
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "develop",
        headSelector: "feature/provider",
        source: { refName: "feature/provider", repository: "example/selected" },
        target: { refName: "develop", repository: "example/selected" },
        hostname: "gitlab.example.test",
        title: "Selected repository MR",
        bodyFile: "/tmp/body.md",
      });
      const defaultBranch = yield* glab.getDefaultBranch({
        cwd: "/repo",
        repository: "example/selected",
        hostname: "gitlab.example.test",
      });

      expect(mockedRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "mr",
            "list",
            "--repo",
            "https://gitlab.example.test/example/selected",
            "--source-branch",
            "feature/provider",
            "--target-branch",
            "release",
            "--per-page",
            "1",
            "--output",
            "json",
          ],
        }),
      );
      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--hostname",
            "gitlab.example.test",
            "--method",
            "POST",
            "projects/example%2Fselected/merge_requests",
            "--raw-field",
            "source_branch=feature/provider",
            "--raw-field",
            "target_branch=develop",
            "--raw-field",
            "title=Selected repository MR",
            "--field",
            "description=@/tmp/body.md",
          ],
        }),
      );
      expect(mockedRun).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["api", "--hostname", "gitlab.example.test", "projects/example%2Fselected"],
        }),
      );
      assert.strictEqual(defaultBranch, "develop");
    }),
  );

  it.effect("resolves a numeric source project ID for cross-project merge requests", () =>
    Effect.gen(function* () {
      mockedRun
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({ id: 4312 }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/provider",
        source: { refName: "feature/provider", repository: "fork/repository" },
        target: { refName: "main", repository: "upstream/repository" },
        hostname: "code.example.test",
        title: "Cross-project MR",
        bodyFile: "/tmp/body.md",
      });

      expect(mockedRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["api", "--hostname", "code.example.test", "projects/fork%2Frepository"],
        }),
      );
      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--hostname",
            "code.example.test",
            "--method",
            "POST",
            "projects/upstream%2Frepository/merge_requests",
            "--raw-field",
            "source_branch=feature/provider",
            "--raw-field",
            "target_branch=main",
            "--field",
            "source_project_id=4312",
            "--raw-field",
            "title=Cross-project MR",
            "--field",
            "description=@/tmp/body.md",
          ],
        }),
      );
    }),
  );

  it.effect("fails before creation when a cross-project source has no numeric project ID", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({ id: "fork/repository" }),
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .createMergeRequest({
          cwd: "/repo",
          baseBranch: "main",
          headSelector: "feature/provider",
          source: { refName: "feature/provider", repository: "fork/repository" },
          target: { refName: "main", repository: "upstream/repository" },
          title: "Cross-project MR",
          bodyFile: "/tmp/body.md",
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, GitLabCli.GitLabRepositoryDecodeError);
      assert.strictEqual(error.operation, "createMergeRequest");
      assert.strictEqual(mockedRun.mock.calls.length, 1);
    }),
  );

  it.effect("creates repositories under an explicit namespace", () =>
    Effect.gen(function* () {
      mockedRun

        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({ id: 1234 }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                path_with_namespace: "octocat/shuv2code",
                web_url: "https://gitlab.com/octocat/shuv2code",
                http_url_to_repo: "https://gitlab.com/octocat/shuv2code.git",
                ssh_url_to_repo: "git@gitlab.com:octocat/shuv2code.git",
              }),
            ),
          ),
        );

      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.createRepository({
        cwd: "/repo",
        repository: "octocat/shuv2code",
        visibility: "public",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/shuv2code",
        url: "https://gitlab.com/octocat/shuv2code",
        sshUrl: "git@gitlab.com:octocat/shuv2code.git",
      });
      expect(mockedRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["api", "namespaces/octocat"],
        }),
      );
      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects",
            "--raw-field",
            "path=shuv2code",
            "--raw-field",
            "name=shuv2code",
            "--raw-field",
            "visibility=public",
            "--raw-field",
            "namespace_id=1234",
          ],
        }),
      );
    }),
  );

  it.effect("does not pass unsupported force flags when checking out merge requests", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.checkoutMergeRequest({
        cwd: "/repo",
        reference: "42",
        force: true,
      });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "checkout", "42"],
        }),
      );
    }),
  );

  it.effect("surfaces a friendly error when the merge request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 merge request not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Merge request 4888 was not found"), true);
      assert.strictEqual(error._tag, "GitLabMergeRequestNotFoundError");
      assert.strictEqual(error.command, "glab");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }),
  );

  it.effect("keeps non-merge-request not-found failures generic", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 project not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "missing/project",
        });
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliCommandError");
      assert.strictEqual(error.cause, cause);
    }),
  );
});
