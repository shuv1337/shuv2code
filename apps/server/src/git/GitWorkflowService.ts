import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  GitManagerError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsDescribeChangeInput,
  type VcsDescribeChangeResult,
  type VcsFetchInput,
  type VcsFetchResult,
  type VcsPushBookmarkInput,
  type VcsPushBookmarkResult,
  type VcsStartChangeInput,
  type VcsStartChangeResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
  type VcsError,
  type VcsRepositorySelection,
} from "@shuv2code/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitVcsDriver.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitManagerServiceError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitManagerServiceError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitManagerServiceError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitManagerServiceError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitManagerServiceError>;
    readonly renameBranch: (input: {
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
    readonly fetch: (input: VcsFetchInput) => Effect.Effect<VcsFetchResult, GitManagerServiceError>;
    readonly describeChange: (
      input: VcsDescribeChangeInput,
    ) => Effect.Effect<VcsDescribeChangeResult, GitManagerServiceError>;
    readonly startChange: (
      input: VcsStartChangeInput,
    ) => Effect.Effect<VcsStartChangeResult, GitManagerServiceError>;
    readonly pushBookmark: (
      input: VcsPushBookmarkInput,
    ) => Effect.Effect<VcsPushBookmarkResult, GitManagerServiceError>;
  }
>()("shuv2code/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(selection?: VcsRepositorySelection): VcsStatusLocalResult {
  return {
    kind: "unknown",
    capabilities: {
      kind: "unknown",
      supportsWorktrees: false,
      supportsBookmarks: false,
      supportsAtomicSnapshot: false,
      supportsPushDefaultRemote: false,
      supportsStatus: false,
      supportsRefMutation: false,
      supportsWorkspaceMutation: false,
      supportsDescribeChange: false,
      supportsStartChange: false,
      supportsFetch: false,
      supportsPush: false,
      supportsChangeRequests: false,
      supportsJuzu: false,
      ignoreClassifier: "native",
    },
    ...(selection ? { selection } : {}),
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    workingCopy: null,
  };
}

function nonRepositoryStatus(selection?: VcsRepositorySelection): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(selection),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitManagerError({
        operation,
        cwd,
        detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
      });
    }
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
  });

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const inspection = yield* registry.inspect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      if (!inspection.handle) {
        return inspection;
      }
      if (inspection.handle.kind !== "git" && inspection.handle.kind !== "jj") {
        return yield* new GitManagerError({
          operation,
          cwd,
          detail: `The ${operation} status workflow requires a Git-compatible repository; detected ${inspection.handle.kind}. (${cwd})`,
        });
      }
      return inspection;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return null;
    }
    if (handle.kind !== "git" && handle.kind !== "jj") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} read workflow requires a Git-compatible repository; detected ${handle.kind}.`,
      });
    }
    return handle;
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  const mapVcsWorkflowError = (operation: string, cwd: string) =>
    Effect.mapError(
      (cause: unknown) =>
        new GitManagerError({
          operation,
          cwd,
          detail: `The ${operation} VCS operation failed.`,
          cause,
        }),
    );

  const requireDriverOperation = <A>(
    operation: string,
    cwd: string,
    run: Effect.Effect<A, VcsError> | undefined,
  ): Effect.Effect<A, GitManagerError> =>
    run
      ? run.pipe(mapVcsWorkflowError(operation, cwd))
      : Effect.fail(
          new GitManagerError({
            operation,
            cwd,
            detail: `The detected VCS driver does not support ${operation}.`,
          }),
        );

  const requireDriverCommandOperation = <A>(
    operation: string,
    cwd: string,
    run: Effect.Effect<A, VcsError> | undefined,
  ): Effect.Effect<A, GitCommandError> =>
    run
      ? run.pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation,
                command: "vcs-route",
                cwd,
                detail: `The ${operation} VCS command failed.`,
                cause,
              }),
          ),
        )
      : Effect.fail(
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: `The detected VCS driver does not support ${operation}.`,
          }),
        );

  const toLocalStatus = (status: VcsStatusResult): VcsStatusLocalResult => ({
    kind: status.kind,
    capabilities: status.capabilities,
    ...(status.selection ? { selection: status.selection } : {}),
    isRepo: status.isRepo,
    ...(status.sourceControlProvider
      ? { sourceControlProvider: status.sourceControlProvider }
      : {}),
    hasPrimaryRemote: status.hasPrimaryRemote,
    isDefaultRef: status.isDefaultRef,
    refName: status.refName,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
    workingCopy: status.workingCopy,
  });

  const attachSelection = <T extends VcsStatusLocalResult | VcsStatusResult>(
    status: T,
    handle: VcsDriverRegistry.VcsDriverHandle,
  ): T => (handle.selection ? { ...status, selection: handle.selection } : status);

  return GitWorkflowService.of({
    status: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((inspection) => {
          const handle = inspection.handle;
          return handle?.kind === "git"
            ? gitManager.status(input).pipe(Effect.map((status) => attachSelection(status, handle)))
            : handle?.kind === "jj"
              ? requireDriverOperation("status", input.cwd, handle.driver.status?.(input)).pipe(
                  Effect.map((status) => attachSelection(status, handle)),
                )
              : Effect.succeed(nonRepositoryStatus(inspection.selection));
        }),
      ),
    localStatus: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((inspection) => {
          const handle = inspection.handle;
          return handle?.kind === "git"
            ? gitManager
                .localStatus(input)
                .pipe(Effect.map((status) => attachSelection(status, handle)))
            : handle?.kind === "jj"
              ? requireDriverOperation(
                  "localStatus",
                  input.cwd,
                  handle.driver.status?.(input),
                ).pipe(
                  Effect.map((status) => attachSelection(status, handle)),
                  Effect.map(toLocalStatus),
                )
              : Effect.succeed(nonRepositoryLocalStatus(inspection.selection));
        }),
      ),
    remoteStatus: (input, options) =>
      detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((inspection) => {
          const handle = inspection.handle;
          return handle?.kind === "git"
            ? gitManager.remoteStatus(input, options)
            : Effect.succeed(null);
        }),
      ),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: (cwd) =>
      ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      ),
    runStackedAction: (input, options) =>
      ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.andThen(gitManager.runStackedAction(input, options)),
      ),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: routeGitManager(
      "GitWorkflowService.preparePullRequestThread",
      gitManager.preparePullRequestThread,
    ),
    listRefs: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git"
            ? git.listRefs(input)
            : handle?.kind === "jj"
              ? requireDriverCommandOperation(
                  "listRefs",
                  input.cwd,
                  handle.driver.listRefs?.(input),
                )
              : Effect.succeed(nonRepositoryListRefs()),
        ),
      ),
    createWorktree: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git"
            ? git.createWorktree(input)
            : handle?.kind === "jj"
              ? requireDriverCommandOperation(
                  "createWorktree",
                  input.cwd,
                  handle.driver.createWorktree?.(input),
                )
              : Effect.fail(
                  new GitCommandError({
                    operation: "createWorktree",
                    command: "vcs-route",
                    cwd: input.cwd,
                    detail: "No repository detected.",
                  }),
                ),
        ),
      ),
    fetchRemote: (input) =>
      ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      ),
    resolveRemoteTrackingCommit: (input) =>
      ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
        Effect.andThen(git.resolveRemoteTrackingCommit(input)),
      ),
    removeWorktree: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git"
            ? git.removeWorktree(input)
            : handle?.kind === "jj"
              ? requireDriverCommandOperation(
                  "removeWorktree",
                  input.cwd,
                  handle.driver.removeWorktree?.(input),
                )
              : Effect.fail(
                  new GitCommandError({
                    operation: "removeWorktree",
                    command: "vcs-route",
                    cwd: input.cwd,
                    detail: "No repository detected.",
                  }),
                ),
        ),
      ),
    createRef: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git"
            ? git.createRef(input)
            : handle?.kind === "jj"
              ? requireDriverCommandOperation(
                  "createRef",
                  input.cwd,
                  handle.driver.createRef?.(input),
                )
              : Effect.fail(
                  new GitCommandError({
                    operation: "createRef",
                    command: "vcs-route",
                    cwd: input.cwd,
                    detail: "No repository detected.",
                  }),
                ),
        ),
      ),
    switchRef: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git"
            ? Effect.scoped(git.switchRef(input))
            : handle?.kind === "jj"
              ? requireDriverCommandOperation(
                  "switchRef",
                  input.cwd,
                  handle.driver.switchRef?.(input),
                )
              : Effect.fail(
                  new GitCommandError({
                    operation: "switchRef",
                    command: "vcs-route",
                    cwd: input.cwd,
                    detail: "No repository detected.",
                  }),
                ),
        ),
      ),
    renameBranch: (input) =>
      ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      ),
    fetch: (input) =>
      registry.resolve({ cwd: input.cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "fetch",
              cwd: input.cwd,
              detail: "Failed to resolve VCS driver.",
              cause,
            }),
        ),
        Effect.flatMap((handle) =>
          requireDriverOperation("fetch", input.cwd, handle.driver.fetch?.(input)),
        ),
      ),
    describeChange: (input) =>
      registry.resolve({ cwd: input.cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "describeChange",
              cwd: input.cwd,
              detail: "Failed to resolve VCS driver.",
              cause,
            }),
        ),
        Effect.flatMap((handle) =>
          requireDriverOperation(
            "describeChange",
            input.cwd,
            handle.driver.describeChange?.(input),
          ),
        ),
      ),
    startChange: (input) =>
      registry.resolve({ cwd: input.cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "startChange",
              cwd: input.cwd,
              detail: "Failed to resolve VCS driver.",
              cause,
            }),
        ),
        Effect.flatMap((handle) =>
          requireDriverOperation("startChange", input.cwd, handle.driver.startChange?.(input)),
        ),
      ),
    pushBookmark: (input) =>
      registry.resolve({ cwd: input.cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "pushBookmark",
              cwd: input.cwd,
              detail: "Failed to resolve VCS driver.",
              cause,
            }),
        ),
        Effect.flatMap((handle) =>
          requireDriverOperation("pushBookmark", input.cwd, handle.driver.pushBookmark?.(input)),
        ),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
