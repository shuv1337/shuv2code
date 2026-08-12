import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  SourceControlProviderError,
  type ChangeRequest,
  type ChangeRequestState,
} from "@shuv2code/contracts";
import { parseGitHubRepositorySelectorFromRemoteUrl } from "@shuv2code/shared/git";

import * as GitHubCli from "./GitHubCli.ts";
import { findAuthenticatedGitHubAccount, parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import { decodeGitHubPullRequestListJson } from "./gitHubPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

function toChangeRequest(summary: GitHubCli.GitHubPullRequestSummary): ChangeRequest {
  return {
    provider: "github",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
    updatedAt: Option.none(),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

function normalizeGitHubRepositoryNameWithOwner(repository: string | undefined): string | null {
  const normalized =
    repository
      ?.trim()
      .replace(/^\/+|\/+$/gu, "")
      .replace(/\.git$/iu, "") ?? "";
  const segments = normalized.split("/");
  if (segments.length !== 2 || segments.some((segment) => !segment || /\s/u.test(segment))) {
    return null;
  }
  return normalized;
}

function contextRepositoryNameWithOwner(
  context: SourceControlProvider.SourceControlProviderContext | undefined,
): string | null {
  if (context?.provider.kind !== "github") {
    return null;
  }
  const selector = parseGitHubRepositorySelectorFromRemoteUrl(context.remoteUrl);
  if (!selector) {
    return null;
  }
  const segments = selector.split("/");
  return segments.length === 2 ? selector : segments.slice(-2).join("/");
}

interface GitHubChangeRequestHead {
  readonly branch: string;
  readonly owner: string | null;
}

function changeRequestHead(input: {
  readonly context?: SourceControlProvider.SourceControlProviderContext;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
  readonly target?: SourceControlProvider.SourceControlRefSelector;
  readonly headSelector: string;
}): GitHubChangeRequestHead {
  const branch = SourceControlProvider.sourceBranch(input);
  const sourceRepository = normalizeGitHubRepositoryNameWithOwner(input.source?.repository);
  const targetRepository =
    contextRepositoryNameWithOwner(input.context) ??
    normalizeGitHubRepositoryNameWithOwner(input.target?.repository);

  if (sourceRepository && targetRepository) {
    if (sourceRepository.toLowerCase() === targetRepository.toLowerCase()) {
      return { branch, owner: null };
    }
    const sourceOwner = sourceRepository.split("/", 1)[0];
    return { branch, owner: sourceOwner ?? null };
  }

  const owner =
    input.source?.owner ??
    SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)?.owner;
  return { branch, owner: owner ?? null };
}

function filterByHeadOwner<Item extends GitHubCli.GitHubPullRequestSummary>(
  items: ReadonlyArray<Item>,
  head: GitHubChangeRequestHead,
  limit: number,
  queryLimit: number,
  cwd: string,
): Effect.Effect<ReadonlyArray<Item>, GitHubCli.GitHubCliCommandError> {
  if (!head.owner) {
    return Effect.succeed(items.slice(0, limit));
  }
  if (items.some((item) => !item.headRepositoryOwnerLogin)) {
    return Effect.fail(
      new GitHubCli.GitHubCliCommandError({
        command: "gh",
        cwd,
        cause: new Error("GitHub CLI omitted a head repository owner for fork disambiguation."),
      }),
    );
  }

  const filtered = items.filter(
    (item) => item.headRepositoryOwnerLogin?.toLowerCase() === head.owner?.toLowerCase(),
  );
  if (filtered.length === 0 && items.length >= queryLimit) {
    return Effect.fail(
      new GitHubCli.GitHubCliCommandError({
        command: "gh",
        cwd,
        cause: new Error("GitHub CLI fork lookup reached its bounded candidate limit."),
      }),
    );
  }
  return Effect.succeed(filtered.slice(0, limit));
}

function parseGitHubAuth(input: SourceControlAuthProbeInput) {
  const output = combinedAuthOutput(input);
  const authStatus = parseGitHubAuthStatus(input.stdout);
  const authenticatedAccount = findAuthenticatedGitHubAccount(authStatus.accounts);
  const host = authenticatedAccount?.host;

  if (authenticatedAccount) {
    return providerAuth({
      status: "authenticated",
      account: authenticatedAccount.account,
      host,
    });
  }

  const failedAccount = authStatus.accounts.find((entry) => entry.active) ?? authStatus.accounts[0];
  if (authStatus.parsed) {
    return providerAuth({
      status: "unauthenticated",
      host: failedAccount?.host,
      detail:
        failedAccount?.error ??
        "Run `gh auth login` to authenticate GitHub CLI with an active account.",
    });
  }

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      host,
      detail: firstSafeAuthLine(output) ?? "Run `gh auth login` to authenticate GitHub CLI.",
    });
  }

  return providerAuth({
    status: "unknown",
    host,
    detail: firstSafeAuthLine(output) ?? "GitHub CLI auth status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: "github",
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "hosts"],
  parseAuth: parseGitHubAuth,
  installHint:
    "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
} satisfies SourceControlCliDiscoverySpec;

export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const contextRepositoryInput = (
    context: SourceControlProvider.SourceControlProviderContext | undefined,
    operation: string,
    cwd: string,
  ): Effect.Effect<{ readonly repository?: string }, SourceControlProviderError> => {
    if (context === undefined) {
      return Effect.succeed({});
    }

    const repository =
      context.provider.kind === "github"
        ? parseGitHubRepositorySelectorFromRemoteUrl(context.remoteUrl)
        : null;
    if (!repository) {
      return Effect.fail(
        new SourceControlProviderError({
          provider: "github",
          operation,
          cwd,
          detail: "The selected GitHub remote does not contain a valid GitHub repository URL.",
        }),
      );
    }
    return Effect.succeed({ repository });
  };

  const listChangeRequests: SourceControlProvider.SourceControlProvider["Service"]["listChangeRequests"] =
    (input) =>
      contextRepositoryInput(input.context, "listChangeRequests", input.cwd).pipe(
        Effect.flatMap((repositoryInput) => {
          const head = changeRequestHead(input);
          const requestedLimit = input.limit ?? (input.state === "open" ? 1 : 20);
          const queryLimit = head.owner ? Math.max(requestedLimit, 100) : requestedLimit;
          if (input.state === "open") {
            return github
              .listOpenPullRequests({
                cwd: input.cwd,
                headSelector: head.branch,
                ...(input.target ? { target: input.target } : {}),
                ...repositoryInput,
                limit: queryLimit,
              })
              .pipe(
                Effect.flatMap((items) =>
                  filterByHeadOwner(items, head, requestedLimit, queryLimit, input.cwd),
                ),
                Effect.map((items) => items.map(toChangeRequest)),
                Effect.mapError(
                  (error) =>
                    new SourceControlProviderError({
                      provider: "github",
                      operation: "listChangeRequests",
                      command: error.command,
                      cwd: input.cwd,
                      reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                        input.headSelector,
                      ),
                      detail: error.detail,
                      cause: error,
                    }),
                ),
              );
          }

          const stateArg: ChangeRequestState | "all" = input.state;
          return github
            .execute({
              cwd: input.cwd,
              args: [
                "pr",
                "list",
                ...(repositoryInput.repository ? ["--repo", repositoryInput.repository] : []),
                "--head",
                head.branch,
                ...(input.target ? ["--base", input.target.refName] : []),
                "--state",
                stateArg,
                "--limit",
                String(queryLimit),
                "--json",
                "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
              ],
            })
            .pipe(
              Effect.flatMap((result) => {
                const raw = result.stdout.trim();
                if (raw.length === 0) {
                  return Effect.succeed([]);
                }
                return Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
                  Effect.flatMap((decoded) =>
                    Result.isSuccess(decoded)
                      ? Effect.succeed(decoded.success)
                      : Effect.fail(
                          new GitHubCli.GitHubChangeRequestListDecodeError({
                            command: "gh",
                            cwd: input.cwd,
                            cause: decoded.failure,
                          }),
                        ),
                  ),
                );
              }),
              Effect.flatMap((items) =>
                filterByHeadOwner(items, head, requestedLimit, queryLimit, input.cwd),
              ),
              Effect.map((items) =>
                items.map((item) => ({
                  ...toChangeRequest(item),
                  updatedAt: item.updatedAt,
                })),
              ),
              Effect.mapError(
                (error) =>
                  new SourceControlProviderError({
                    provider: "github",
                    operation: "listChangeRequests",
                    command: error.command,
                    cwd: input.cwd,
                    reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                      input.headSelector,
                    ),
                    detail: error.detail,
                    cause: error,
                  }),
              ),
            );
        }),
      );

  return SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests,
    getChangeRequest: (input) =>
      contextRepositoryInput(input.context, "getChangeRequest", input.cwd).pipe(
        Effect.flatMap((repositoryInput) =>
          github
            .getPullRequest({
              cwd: input.cwd,
              reference: input.reference,
              ...repositoryInput,
            })
            .pipe(
              Effect.map(toChangeRequest),
              Effect.mapError(
                (error) =>
                  new SourceControlProviderError({
                    provider: "github",
                    operation: "getChangeRequest",
                    command: error.command,
                    cwd: input.cwd,
                    reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                      input.reference,
                    ),
                    detail: error.detail,
                    cause: error,
                  }),
              ),
            ),
        ),
      ),
    createChangeRequest: (input) =>
      contextRepositoryInput(input.context, "createChangeRequest", input.cwd).pipe(
        Effect.flatMap((repositoryInput) =>
          github
            .createPullRequest({
              cwd: input.cwd,
              baseBranch: input.baseRefName,
              headSelector: ((head) => (head.owner ? `${head.owner}:${head.branch}` : head.branch))(
                changeRequestHead(input),
              ),
              title: input.title,
              bodyFile: input.bodyFile,
              ...repositoryInput,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new SourceControlProviderError({
                    provider: "github",
                    operation: "createChangeRequest",
                    command: error.command,
                    cwd: input.cwd,
                    reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                      input.headSelector,
                    ),
                    detail: error.detail,
                    cause: error,
                  }),
              ),
            ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      github.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "getRepositoryCloneUrls",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      github.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "createRepository",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) =>
      contextRepositoryInput(input.context, "getDefaultBranch", input.cwd).pipe(
        Effect.flatMap((repositoryInput) =>
          github
            .getDefaultBranch({
              cwd: input.cwd,
              ...repositoryInput,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new SourceControlProviderError({
                    provider: "github",
                    operation: "getDefaultBranch",
                    command: error.command,
                    cwd: input.cwd,
                    detail: error.detail,
                    cause: error,
                  }),
              ),
            ),
        ),
      ),
    checkoutChangeRequest: (input) =>
      contextRepositoryInput(input.context, "checkoutChangeRequest", input.cwd).pipe(
        Effect.flatMap((repositoryInput) =>
          github
            .checkoutPullRequest({
              cwd: input.cwd,
              reference: input.reference,
              ...(input.force !== undefined ? { force: input.force } : {}),
              ...repositoryInput,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new SourceControlProviderError({
                    provider: "github",
                    operation: "checkoutChangeRequest",
                    command: error.command,
                    cwd: input.cwd,
                    reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                      input.reference,
                    ),
                    detail: error.detail,
                    cause: error,
                  }),
              ),
            ),
        ),
      ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
