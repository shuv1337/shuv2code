import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SourceControlProviderError, type ChangeRequest } from "@shuv2code/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

function parseAzureAuth(input: SourceControlAuthProbeInput) {
  const account = input.stdout.trim().split(/\r?\n/)[0]?.trim();

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail:
        firstSafeAuthLine(combinedAuthOutput(input)) ?? "Run `az login` to authenticate Azure CLI.",
    });
  }

  if (account !== undefined && account.length > 0) {
    return providerAuth({
      status: "authenticated",
      account,
      host: "dev.azure.com",
    });
  }

  return providerAuth({
    status: "unknown",
    host: "dev.azure.com",
    detail: "Azure CLI account status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: "azure-devops",
  label: "Azure DevOps",
  executable: "az",
  versionArgs: ["--version"],
  authArgs: ["account", "show", "--query", "user.name", "-o", "tsv"],
  parseAuth: parseAzureAuth,
  installHint:
    "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
} satisfies SourceControlCliDiscoverySpec;

function toChangeRequest(summary: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: ChangeRequest["updatedAt"];
}): ChangeRequest {
  return {
    provider: "azure-devops",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt,
    isCrossRepository: false,
  };
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pathSegments(value: string): ReadonlyArray<string> {
  return value
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map(decodePathSegment);
}

function azureDevOpsRepositoryLocatorFromPath(
  value: string,
): AzureDevOpsCli.AzureDevOpsRepositoryLocator | null {
  const segments = pathSegments(value.replace(/\.git$/u, ""));
  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === "_git");
  if (gitIndex > 0 && gitIndex < segments.length - 1) {
    const repository = segments.slice(gitIndex + 1).join("/");
    const project = segments[gitIndex - 1];
    const organizationName = gitIndex > 1 ? segments[gitIndex - 2] : undefined;
    if (!project || !repository) return null;
    return {
      repository,
      project,
      ...(organizationName ? { organization: `https://dev.azure.com/${organizationName}` } : {}),
    };
  }
  if (segments.length < 2) return null;
  const repository = segments.at(-1);
  const project = segments.at(-2);
  if (!repository || !project) return null;
  return {
    repository,
    project,
  };
}

function azureDevOpsRepositoryLocatorFromContext(
  context: SourceControlProvider.SourceControlProviderContext | undefined,
): AzureDevOpsCli.AzureDevOpsRepositoryLocator | null {
  if (context === undefined) return null;

  let hostname: string;
  let pathname: string;
  let origin: string | null = null;
  const scpMatch = /^[^@\s]+@([^:\s]+):(.+)$/u.exec(context.remoteUrl.trim());
  if (scpMatch?.[1] && scpMatch[2]) {
    hostname = scpMatch[1].toLowerCase();
    pathname = scpMatch[2];
  } else {
    try {
      const remote = new URL(context.remoteUrl);
      hostname = remote.hostname.toLowerCase();
      pathname = remote.pathname;
      origin = remote.origin;
    } catch {
      return azureDevOpsRepositoryLocatorFromPath(context.remoteUrl);
    }
  }

  const segments = pathSegments(pathname.replace(/\.git$/u, ""));
  if (hostname === "ssh.dev.azure.com" && segments[0]?.toLowerCase() === "v3") {
    const organizationName = segments[1];
    const project = segments[2];
    const repository = segments.slice(3).join("/");
    return organizationName && project && repository
      ? {
          organization: `https://dev.azure.com/${organizationName}`,
          project,
          repository,
        }
      : null;
  }
  if (hostname === "dev.azure.com") {
    const organizationName = segments[0];
    const project = segments[1];
    const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === "_git");
    const repository = gitIndex >= 0 ? segments.slice(gitIndex + 1).join("/") : "";
    return organizationName && project && repository
      ? {
          organization: `https://dev.azure.com/${organizationName}`,
          project,
          repository,
        }
      : null;
  }
  if (hostname.endsWith(".visualstudio.com")) {
    const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === "_git");
    const project = gitIndex > 0 ? segments[gitIndex - 1] : segments[0];
    const repository = gitIndex >= 0 ? segments.slice(gitIndex + 1).join("/") : "";
    return origin && project && repository ? { organization: origin, project, repository } : null;
  }
  return azureDevOpsRepositoryLocatorFromPath(pathname);
}

function azureDevOpsRepositoryLocator(input: {
  readonly context?: SourceControlProvider.SourceControlProviderContext;
  readonly repository?: string;
}): AzureDevOpsCli.AzureDevOpsRepositoryLocator | null {
  return (
    azureDevOpsRepositoryLocatorFromContext(input.context) ??
    (input.repository ? azureDevOpsRepositoryLocatorFromPath(input.repository) : null)
  );
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "azure-devops",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      const repository = azureDevOpsRepositoryLocator({
        ...(input.context ? { context: input.context } : {}),
        ...(source?.repository ? { repository: source.repository } : {}),
      });
      return azure
        .listPullRequests({
          cwd: input.cwd,
          headSelector: input.headSelector,
          ...(source !== undefined ? { source } : {}),
          ...(input.target !== undefined ? { target: input.target } : {}),
          ...(repository ? { repository } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
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
    },
    getChangeRequest: (input) =>
      azure.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
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
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      const repositoryRef = input.target?.repository ?? source?.repository;
      const repository = azureDevOpsRepositoryLocator({
        ...(input.context ? { context: input.context } : {}),
        ...(repositoryRef ? { repository: repositoryRef } : {}),
      });
      return azure
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source !== undefined ? { source } : {}),
          ...(input.target !== undefined ? { target: input.target } : {}),
          ...(repository ? { repository } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
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
        );
    },
    getRepositoryCloneUrls: (input) =>
      azure.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
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
      azure.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
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
    getDefaultBranch: (input) => {
      const repository = azureDevOpsRepositoryLocator(input);
      return azure.getDefaultBranch({ cwd: input.cwd, ...(repository ? { repository } : {}) }).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      );
    },
    checkoutChangeRequest: (input) =>
      azure
        .checkoutPullRequest({
          cwd: input.cwd,
          reference: input.reference,
          ...(input.context !== undefined ? { remoteName: input.context.remoteName } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
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
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
