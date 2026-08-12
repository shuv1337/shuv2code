import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@shuv2code/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

const supportLayer = Layer.mergeAll(
  Layer.mock(VcsProcess.VcsProcess)({
    run: mockRun,
  }),
  NodeServices.layer,
);
const layer = Layer.mergeAll(AzureDevOpsCli.layer.pipe(Layer.provide(supportLayer)), supportLayer);

afterEach(() => {
  mockRun.mockReset();
});

describe("AzureDevOpsCli.layer", () => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              pullRequestId: 42,
              title: "Add Azure provider",
              sourceRefName: "refs/heads/feature/source-control",
              targetRefName: "refs/heads/main",
              status: "active",
              creationDate: "2026-01-02T00:00:00.000Z",
              closedDate: null,
              _links: {
                web: {
                  href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
                },
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Add Azure provider");
      assert.strictEqual(result.url, "https://dev.azure.com/acme/project/_git/repo/pullrequest/42");
      assert.strictEqual(result.baseRefName, "main");
      assert.strictEqual(result.headRefName, "feature/source-control");
      assert.strictEqual(result.state, "open");
      assert.deepStrictEqual(result.updatedAt._tag, Option.some(1)._tag);
      assert.deepStrictEqual(mockRun.mock.calls.at(-1)?.[0], {
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
          "--id",
          "42",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("builds a web URL when Azure returns only the pull request REST URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              pullRequestId: 863,
              title: "Fix Azure link",
              url: "https://dev.azure.com/saplyai/a8fe4088-ad76-4eda-aaaa-e3329713a097/_apis/git/repositories/16108a25-93a3-4eff-b77d-85e894ee0fe4/pullRequests/863",
              repository: {
                name: "CV-engine",
                project: {
                  name: "CV-engine",
                },
              },
              sourceRefName: "refs/heads/feature/azure-pr-link",
              targetRefName: "refs/heads/main",
              status: "active",
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "863",
      });

      assert.strictEqual(
        result.url,
        "https://dev.azure.com/saplyai/CV-engine/_git/CV-engine/pullrequest/863",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists pull requests with Azure status and source branch arguments", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                pullRequestId: 7,
                title: "Merged work",
                sourceRefName: "refs/heads/feature/merged",
                targetRefName: "refs/heads/main",
                status: "completed",
                closedDate: "2026-01-03T00:00:00.000Z",
                _links: {
                  web: {
                    href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/7",
                  },
                },
              },
            ]),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.listPullRequests({
        cwd: "/repo",
        headSelector: "origin:feature/merged",
        target: { refName: "release", repository: "ignored/other" },
        state: "merged",
        limit: 10,
      });

      assert.strictEqual(result[0]?.state, "merged");
      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "list",
          "--detect",
          "true",
          "--source-branch",
          "feature/merged",
          "--target-branch",
          "release",
          "--status",
          "completed",
          "--top",
          "10",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: {
                name: "project",
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "repo",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories through Azure Repos", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: {
                name: "project",
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.createRepository({
        cwd: "/repo",
        repository: "project/repo",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "create",
          "--detect",
          "true",
          "--name",
          "repo",
          "--project",
          "project",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates pull requests through a file payload without placing the body in argv", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bodyFile = yield* fileSystem.makeTempFileScoped({
        prefix: "shuv2code-azure-devops-cli-body-",
        suffix: ".md",
      });
      const body = [
        "# Exact body",
        "",
        "Quotes: \"double\" and 'single'.",
        "Shell-like text stays literal: $(touch nope) `ticks` $HOME; --description @not-a-file",
        "Backslash: \\\\ and Unicode: café ☕",
        "",
        "large-body-sentinel:" + "x".repeat(70_000),
        "",
      ].join("\n");
      yield* fileSystem.writeFileString(bodyFile, body);
      let requestFile: string | null = null;
      let requestBody: string | null = null;
      mockRun
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                id: "repository-id",
                project: { id: "project-id" },
              }),
            ),
          ),
        )
        .mockImplementationOnce((request) =>
          Effect.gen(function* () {
            const fileIndex = request.args.indexOf("--in-file");
            requestFile = request.args[fileIndex + 1] ?? null;
            requestBody = requestFile
              ? yield* fileSystem.readFileString(requestFile).pipe(Effect.orDie)
              : null;
            return processOutput("{}");
          }),
        );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/provider",
        title: "Provider PR",
        bodyFile,
      });

      expect(mockRun).toHaveBeenCalledTimes(2);
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd: "/repo",
        args: ["repos", "show", "--detect", "true", "--only-show-errors", "--output", "json"],
        timeoutMs: 30_000,
      });
      assert.notEqual(requestFile, null);
      expect(mockRun).toHaveBeenNthCalledWith(2, {
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd: "/repo",
        args: [
          "devops",
          "invoke",
          "--only-show-errors",
          "--detect",
          "true",
          "--area",
          "git",
          "--resource",
          "pullRequests",
          "--route-parameters",
          "project=project-id",
          "repositoryId=repository-id",
          "--http-method",
          "POST",
          "--api-version",
          "7.1",
          "--encoding",
          "utf-8",
          "--in-file",
          requestFile,
          "--output",
          "none",
        ],
        timeoutMs: 30_000,
      });
      assert.notEqual(requestBody, null);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepStrictEqual(JSON.parse(requestBody ?? ""), {
        sourceRefName: "refs/heads/feature/provider",
        targetRefName: "refs/heads/main",
        title: "Provider PR",
        description: body,
      });
      assert.equal(mockRun.mock.calls[1]?.[0].args.includes(body), false);
      assert.equal(
        mockRun.mock.calls[1]?.[0].args.join("\0").includes("large-body-sentinel"),
        false,
      );
      assert.equal(mockRun.mock.calls[1]?.[0].args.includes(bodyFile), false);
      assert.equal(yield* fileSystem.exists(requestFile ?? ""), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("uses explicit Azure repository coordinates instead of cwd detection", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bodyFile = yield* fileSystem.makeTempFileScoped({
        prefix: "shuv2code-azure-devops-cli-explicit-body-",
        suffix: ".md",
      });
      yield* fileSystem.writeFileString(bodyFile, "Explicit body");
      mockRun
        .mockReturnValueOnce(Effect.succeed(processOutput("[]")))
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                id: "selected-repository-id",
                project: { id: "selected-project-id" },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(processOutput("{}")))
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                name: "selected-repo",
                webUrl: "https://dev.azure.com/acme/selected-project/_git/selected-repo",
                remoteUrl: "https://dev.azure.com/acme/selected-project/_git/selected-repo",
                sshUrl: "git@ssh.dev.azure.com:v3/acme/selected-project/selected-repo",
                project: { name: "selected-project" },
                defaultBranch: "refs/heads/develop",
              }),
            ),
          ),
        );
      const repository = {
        repository: "selected-repo",
        project: "selected-project",
        organization: "https://dev.azure.com/acme",
      };

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.listPullRequests({
        cwd: "/repo",
        repository,
        headSelector: "feature/provider",
        state: "open",
        limit: 1,
      });
      yield* az.createPullRequest({
        cwd: "/repo",
        repository,
        baseBranch: "develop",
        headSelector: "feature/provider",
        title: "Selected repository PR",
        bodyFile,
      });
      const defaultBranch = yield* az.getDefaultBranch({ cwd: "/repo", repository });
      const selectorArgs = [
        "--detect",
        "false",
        "--repository",
        "selected-repo",
        "--project",
        "selected-project",
        "--organization",
        "https://dev.azure.com/acme",
      ];

      expect(mockRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          command: "az",
          cwd: "/repo",
          args: [
            "repos",
            "pr",
            "list",
            ...selectorArgs,
            "--source-branch",
            "feature/provider",
            "--status",
            "active",
            "--top",
            "1",
            "--only-show-errors",
            "--output",
            "json",
          ],
        }),
      );
      expect(mockRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "az",
          cwd: "/repo",
          args: ["repos", "show", ...selectorArgs, "--only-show-errors", "--output", "json"],
        }),
      );
      expect(mockRun).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          command: "az",
          cwd: "/repo",
          args: [
            "devops",
            "invoke",
            "--only-show-errors",
            "--detect",
            "false",
            "--organization",
            "https://dev.azure.com/acme",
            "--area",
            "git",
            "--resource",
            "pullRequests",
            "--route-parameters",
            "project=selected-project-id",
            "repositoryId=selected-repository-id",
            "--http-method",
            "POST",
            "--api-version",
            "7.1",
            "--encoding",
            "utf-8",
            "--in-file",
            expect.any(String),
            "--output",
            "none",
          ],
        }),
      );
      expect(mockRun).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          command: "az",
          cwd: "/repo",
          args: ["repos", "show", ...selectorArgs, "--only-show-errors", "--output", "json"],
        }),
      );
      assert.strictEqual(defaultBranch, "develop");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not force JSON output on checkout side-effect commands", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.checkoutPullRequest({
        cwd: "/repo",
        reference: "42",
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "checkout",
          "--only-show-errors",
          "--detect",
          "true",
          "--id",
          "42",
          "--remote-name",
          "origin",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves VCS causes without copying upstream details into messages", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsCli.execute",
        command: "az repos list --organization sensitive-upstream-detail",
        cwd: "/repo",
        exitCode: 1,
        detail: "sensitive-upstream-detail",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd: "/repo", args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.operation, "execute");
      assert.strictEqual(error.command, "az");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.argumentCount, 2);
      assert.strictEqual(error.detail, "Azure DevOps CLI command failed.");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes("sensitive-upstream-detail"), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not report a missing working directory as a missing Azure CLI", () =>
    Effect.gen(function* () {
      const cwd = "/missing/repo";
      const platformCause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        syscall: "chdir",
        pathOrDescriptor: cwd,
      });
      const cause = new VcsProcessSpawnError({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd,
        argumentCount: 2,
        cause: platformCause,
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd, args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.cwd, cwd);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps invalid pull request output diagnostics structured", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("not-json")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.getPullRequest({ cwd: "/repo", reference: "42" }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsPullRequestDecodeError);
      assert.strictEqual(error.operation, "getPullRequest");
      assert.strictEqual(error.command, "az");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.outputLength, 8);
      assert.strictEqual(error.detail, "Azure DevOps CLI returned invalid pull request JSON.");
      assert.exists(error.cause);
      assert.strictEqual(
        error.message,
        "Azure DevOps CLI failed in getPullRequest: Azure DevOps CLI returned invalid pull request JSON.",
      );
    }).pipe(Effect.provide(layer)),
  );
});
