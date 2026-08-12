import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  SourceControlRepositoryError,
  type ChangeRequest,
  type SourceControlProviderKind,
  type VcsCreateChangeRequestInput,
  type VcsCreateChangeRequestResult,
  type VcsRemote,
} from "@shuv2code/contracts";

import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

export class VcsChangeRequestService extends Context.Service<
  VcsChangeRequestService,
  {
    readonly create: (
      input: VcsCreateChangeRequestInput,
    ) => Effect.Effect<VcsCreateChangeRequestResult, SourceControlRepositoryError>;
  }
>()("shuv2code/vcs/VcsChangeRequestService") {}

const CHANGE_REQUEST_LOOKUP_LIMIT = 100;

interface RemoteCoordinates {
  readonly hostname: string;
  readonly pathSegments: ReadonlyArray<string>;
}

function decodeRemotePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function remoteCoordinates(remoteUrl: string): RemoteCoordinates | null {
  const normalized = remoteUrl.trim();
  const scpMatch = /^[^@\s]+@([^:\s]+):(.+)$/u.exec(normalized);
  let hostname: string;
  let pathname: string;
  if (scpMatch?.[1] && scpMatch[2]) {
    hostname = scpMatch[1].toLowerCase();
    pathname = scpMatch[2];
  } else {
    try {
      const url = new URL(normalized);
      if (!url.hostname) return null;
      hostname = url.hostname.toLowerCase();
      pathname = url.pathname;
    } catch {
      return null;
    }
  }
  const pathSegments = pathname
    .replace(/\.git\/?$/iu, "")
    .split("/")
    .map((segment) => decodeRemotePathSegment(segment.trim()))
    .filter((segment) => segment.length > 0);
  return pathSegments.length > 0 ? { hostname, pathSegments } : null;
}

function azureOrganization(coordinates: RemoteCoordinates): string | null {
  if (coordinates.hostname === "dev.azure.com") {
    return coordinates.pathSegments[0]?.toLowerCase() ?? null;
  }
  if (
    coordinates.hostname === "ssh.dev.azure.com" &&
    coordinates.pathSegments[0]?.toLowerCase() === "v3"
  ) {
    return coordinates.pathSegments[1]?.toLowerCase() ?? null;
  }
  if (coordinates.hostname.endsWith(".visualstudio.com")) {
    const organization = coordinates.hostname.slice(0, -".visualstudio.com".length);
    return organization.length > 0 ? organization : null;
  }
  return null;
}

function forgeAuthority(provider: SourceControlProviderKind, remoteUrl: string): string | null {
  const coordinates = remoteCoordinates(remoteUrl);
  if (!coordinates) return null;
  if (provider === "azure-devops") {
    const organization = azureOrganization(coordinates);
    return organization ? `azure-devops:${organization}` : null;
  }
  if (provider === "github") {
    const hostname =
      coordinates.hostname === "github.com" || coordinates.hostname === "ssh.github.com"
        ? "github.com"
        : coordinates.hostname;
    return `github:${hostname}`;
  }
  if (provider === "gitlab" || provider === "bitbucket") {
    return `${provider}:${coordinates.hostname}`;
  }
  return null;
}

type ExactChangeRequestLookup =
  | { readonly _tag: "found"; readonly changeRequest: ChangeRequest }
  | { readonly _tag: "missing" }
  | { readonly _tag: "ambiguous" }
  | { readonly _tag: "saturated" };

function classifyExactChangeRequest(
  candidates: ReadonlyArray<ChangeRequest>,
  input: { readonly baseRefName: string; readonly headRefName: string },
): ExactChangeRequestLookup {
  const exact = candidates.filter(
    (candidate) =>
      candidate.baseRefName === input.baseRefName && candidate.headRefName === input.headRefName,
  );
  if (exact.length === 1 && exact[0]) {
    return { _tag: "found", changeRequest: exact[0] };
  }
  if (exact.length > 1) {
    return { _tag: "ambiguous" };
  }
  return candidates.length >= CHANGE_REQUEST_LOOKUP_LIMIT
    ? { _tag: "saturated" }
    : { _tag: "missing" };
}

function repositoryPathFromRemoteUrl(remoteUrl: string): string | null {
  const normalized = remoteUrl
    .trim()
    .replace(/\.git\/?$/u, "")
    .replace(/\/$/u, "");
  const scpMatch = /^[^@\s]+@[^:\s]+:(.+)$/u.exec(normalized);
  if (scpMatch?.[1]) return scpMatch[1];
  try {
    const url = new URL(normalized);
    const repository = url.pathname.replace(/^\/+|\/+$/gu, "");
    return repository.length > 0 ? repository : null;
  } catch {
    return null;
  }
}

function canonicalRepositoryPath(
  provider: SourceControlProviderKind,
  remoteUrl: string,
): string | null {
  const coordinates = remoteCoordinates(remoteUrl);
  if (!coordinates) return null;
  if (provider === "azure-devops") {
    const organization = azureOrganization(coordinates);
    let project: string | undefined;
    let repository: string | undefined;
    if (coordinates.hostname === "ssh.dev.azure.com") {
      project = coordinates.pathSegments[2];
      repository = coordinates.pathSegments.slice(3).join("/");
    } else {
      const gitIndex = coordinates.pathSegments.findIndex(
        (segment) => segment.toLowerCase() === "_git",
      );
      project = gitIndex > 0 ? coordinates.pathSegments[gitIndex - 1] : undefined;
      repository =
        gitIndex >= 0 ? coordinates.pathSegments.slice(gitIndex + 1).join("/") : undefined;
    }
    return organization && project && repository
      ? `${organization}/${project}/${repository}`.toLowerCase()
      : null;
  }
  const repository = coordinates.pathSegments.join("/");
  return repository.length > 0 ? repository : null;
}

function encodeIdentity(parts: ReadonlyArray<string>): string {
  return parts.map((part) => `${part.length}:${part}`).join("|");
}

const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

function mapError(operation: string, cause: unknown): SourceControlRepositoryError {
  if (isSourceControlRepositoryError(cause)) return cause;
  return new SourceControlRepositoryError({
    operation,
    provider: "unknown",
    detail:
      cause instanceof Error
        ? cause.message
        : "The change request operation could not be completed.",
    cause,
  });
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;

  type CreateOutcome = Effect.Effect<VcsCreateChangeRequestResult, SourceControlRepositoryError>;
  interface CreateFlight {
    readonly deferred: Deferred.Deferred<
      VcsCreateChangeRequestResult,
      SourceControlRepositoryError
    >;
  }
  const createFlights = yield* Ref.make<ReadonlyMap<string, CreateFlight>>(new Map());
  const createFlightsGuard = yield* Semaphore.make(1);
  const withCreateFlight = (identity: string, effect: CreateOutcome): CreateOutcome =>
    Effect.acquireUseRelease(
      createFlightsGuard.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(createFlights);
          const existing = current.get(identity);
          if (existing) {
            return { leader: false as const, flight: existing };
          }
          const deferred = yield* Deferred.make<
            VcsCreateChangeRequestResult,
            SourceControlRepositoryError
          >();
          const flight = { deferred };
          yield* Ref.set(createFlights, new Map(current).set(identity, flight));
          return { leader: true as const, flight };
        }),
      ),
      ({ leader, flight }) => {
        if (!leader) return Deferred.await(flight.deferred);
        return Effect.uninterruptibleMask((restore) =>
          restore(effect).pipe(
            Effect.exit,
            Effect.tap((exit) => Deferred.done(flight.deferred, exit)),
            Effect.flatMap(Exit.match({ onFailure: Effect.failCause, onSuccess: Effect.succeed })),
          ),
        );
      },
      ({ leader, flight }) =>
        leader
          ? createFlightsGuard.withPermits(1)(
              Ref.update(createFlights, (current) => {
                if (current.get(identity) !== flight) return current;
                const next = new Map(current);
                next.delete(identity);
                return next;
              }),
            )
          : Effect.void,
    ).pipe(Effect.withSpan("VcsChangeRequestService.withCreateFlight"));

  const create = Effect.fn("VcsChangeRequestService.create")(function* (
    input: VcsCreateChangeRequestInput,
  ) {
    const handle = yield* vcs.resolve({ cwd: input.cwd });
    if (handle.kind !== "jj" || !handle.driver.capabilities.supportsChangeRequests) {
      return yield* new SourceControlRepositoryError({
        operation: "createChangeRequest",
        provider: "unknown",
        detail: `Change requests are not available for the detected ${handle.kind} workflow.`,
      });
    }
    if (!handle.driver.pushBookmark || !handle.driver.listRefs) {
      return yield* new SourceControlRepositoryError({
        operation: "createChangeRequest",
        provider: "unknown",
        detail: "The detected VCS driver cannot publish an explicit bookmark.",
      });
    }
    const pushBookmark = handle.driver.pushBookmark;
    const listRefs = handle.driver.listRefs;

    let providerHandle: SourceControlProviderRegistry.SourceControlProviderHandle;
    let selectedRemote: VcsRemote | undefined;
    if (input.remoteName) {
      const remotes = yield* handle.driver.listRemotes(input.cwd);
      const remote = remotes.remotes.find((candidate) => candidate.name === input.remoteName);
      if (!remote) {
        return yield* new SourceControlRepositoryError({
          operation: "createChangeRequest",
          provider: "unknown",
          detail: "The selected remote is not configured for this repository.",
        });
      }
      selectedRemote = remote;
      providerHandle = yield* providers.resolveRemoteHandle({
        cwd: input.cwd,
        remoteName: remote.name,
        remoteUrl: remote.url,
      });
    } else {
      providerHandle = yield* providers.resolveHandle({ cwd: input.cwd });
    }
    if (providerHandle.context === null || providerHandle.provider.kind === "unknown") {
      return yield* new SourceControlRepositoryError({
        operation: "createChangeRequest",
        provider: "unknown",
        detail: "No supported source-control provider was detected for the JJ remote.",
      });
    }
    let providerContext = providerHandle.context;
    if (!selectedRemote) {
      const remotes = yield* handle.driver.listRemotes(input.cwd);
      selectedRemote = remotes.remotes.find(
        (candidate) => candidate.name === providerContext.remoteName,
      );
      if (!selectedRemote) {
        return yield* new SourceControlRepositoryError({
          operation: "createChangeRequest",
          provider: providerHandle.provider.kind,
          detail: "The resolved source-control remote is not configured for this repository.",
        });
      }
      if (selectedRemote.url !== providerContext.remoteUrl) {
        const refreshedProviderHandle = yield* providers.resolveRemoteHandle({
          cwd: input.cwd,
          remoteName: selectedRemote.name,
          remoteUrl: selectedRemote.url,
        });
        if (
          refreshedProviderHandle.context === null ||
          refreshedProviderHandle.provider.kind === "unknown"
        ) {
          return yield* new SourceControlRepositoryError({
            operation: "createChangeRequest",
            provider: "unknown",
            detail: "No supported source-control provider was detected for the JJ remote.",
          });
        }
        providerHandle = refreshedProviderHandle;
        providerContext = refreshedProviderHandle.context;
      }
    }
    if (
      providerContext.remoteName !== selectedRemote.name ||
      providerContext.remoteUrl !== selectedRemote.url
    ) {
      return yield* new SourceControlRepositoryError({
        operation: "createChangeRequest",
        provider: providerHandle.provider.kind,
        detail: "The resolved source-control provider does not match the selected remote.",
      });
    }
    const sourceRemoteUrl = Option.getOrElse(selectedRemote.pushUrl, () => selectedRemote.url);
    const sourceAuthority = forgeAuthority(providerHandle.provider.kind, sourceRemoteUrl);
    const targetAuthority = forgeAuthority(providerHandle.provider.kind, providerContext.remoteUrl);
    if (!sourceAuthority || !targetAuthority || sourceAuthority !== targetAuthority) {
      return yield* new SourceControlRepositoryError({
        operation: "createChangeRequest",
        provider: providerHandle.provider.kind,
        detail: "The source push remote is not on the selected source-control host.",
      });
    }
    const sourceRepository = repositoryPathFromRemoteUrl(sourceRemoteUrl);
    const targetRepository = repositoryPathFromRemoteUrl(providerContext.remoteUrl);
    const canonicalSourceRepository = canonicalRepositoryPath(
      providerHandle.provider.kind,
      sourceRemoteUrl,
    );
    const canonicalTargetRepository = canonicalRepositoryPath(
      providerHandle.provider.kind,
      providerContext.remoteUrl,
    );
    if (
      !sourceRepository ||
      !targetRepository ||
      !canonicalSourceRepository ||
      !canonicalTargetRepository
    ) {
      return yield* new SourceControlRepositoryError({
        operation: "createChangeRequest",
        provider: providerHandle.provider.kind,
        detail: "The selected source and target repositories could not be resolved safely.",
      });
    }
    if (
      providerHandle.provider.kind === "azure-devops" &&
      canonicalSourceRepository !== canonicalTargetRepository
    ) {
      return yield* new SourceControlRepositoryError({
        operation: "createChangeRequest",
        provider: providerHandle.provider.kind,
        detail:
          "Azure DevOps fork pull requests are not supported by the current provider adapter.",
      });
    }
    const source = {
      refName: input.bookmarkName,
      repository: sourceRepository,
    };

    const detectedBase = input.remoteName
      ? null
      : ((yield* listRefs({
          cwd: input.cwd,
          limit: 200,
        })).refs.find((ref) => ref.isDefault)?.name ?? null);
    const providerDefault =
      input.baseRefName || detectedBase
        ? null
        : yield* providerHandle.provider
            .getDefaultBranch({ cwd: input.cwd, context: providerContext })
            .pipe(Effect.orElseSucceed(() => null));
    const baseRefName = input.baseRefName ?? detectedBase ?? providerDefault;
    if (!baseRefName) {
      return yield* new SourceControlRepositoryError({
        operation: "createChangeRequest",
        provider: providerHandle.provider.kind,
        detail: "Choose a target bookmark before creating the change request.",
      });
    }

    const lookupExact = Effect.fn("VcsChangeRequestService.lookupExact")(function* () {
      const candidates = yield* providerHandle.provider.listChangeRequests({
        cwd: input.cwd,
        context: providerContext,
        source,
        target: { refName: baseRefName, repository: targetRepository },
        headSelector: input.bookmarkName,
        state: "open",
        limit: CHANGE_REQUEST_LOOKUP_LIMIT,
      });
      return classifyExactChangeRequest(candidates, {
        baseRefName,
        headRefName: input.bookmarkName,
      });
    });
    const ambiguousLookupError = () =>
      new SourceControlRepositoryError({
        operation: "createChangeRequest",
        provider: providerHandle.provider.kind,
        detail: "The change-request lookup was ambiguous or reached its bounded candidate limit.",
      });
    const resultFromExact = (
      changeRequest: ChangeRequest,
      status: "created" | "opened_existing",
    ): VcsCreateChangeRequestResult => ({
      status,
      bookmarkName: input.bookmarkName,
      baseRefName,
      url: changeRequest.url,
      number: changeRequest.number,
    });
    const createIdentity = encodeIdentity([
      handle.repository.rootPath,
      providerHandle.provider.kind,
      targetAuthority,
      canonicalTargetRepository,
      sourceAuthority,
      canonicalSourceRepository,
      input.bookmarkName,
      baseRefName,
    ]);

    return yield* withCreateFlight(
      createIdentity,
      Effect.gen(function* () {
        yield* pushBookmark({
          cwd: input.cwd,
          bookmarkName: input.bookmarkName,
          remoteName: providerContext.remoteName,
        });

        const existing = yield* lookupExact();
        if (existing._tag === "found") {
          return resultFromExact(existing.changeRequest, "opened_existing");
        }
        if (existing._tag === "ambiguous" || existing._tag === "saturated") {
          return yield* ambiguousLookupError();
        }

        const bodyFile = path.join(
          NodeOS.tmpdir(),
          `shuv2code-change-request-${NodeCrypto.randomUUID()}.md`,
        );
        yield* fileSystem.writeFileString(bodyFile, input.body);
        const createError = yield* providerHandle.provider
          .createChangeRequest({
            cwd: input.cwd,
            context: providerContext,
            source,
            target: { refName: baseRefName, repository: targetRepository },
            baseRefName,
            headSelector: input.bookmarkName,
            title: input.title,
            bodyFile,
          })
          .pipe(
            Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))),
            Effect.as(null),
            Effect.catch((error) => Effect.succeed(error)),
          );

        if (createError) {
          const reconciled = yield* lookupExact().pipe(Effect.exit);
          if (reconciled._tag === "Success" && reconciled.value._tag === "found") {
            return resultFromExact(reconciled.value.changeRequest, "created");
          }
          return yield* createError;
        }

        // Creation succeeded. A metadata lookup is best effort, but it may only
        // supply metadata when exactly one request matches the full identity.
        const created = yield* lookupExact().pipe(
          Effect.orElseSucceed(() => ({ _tag: "missing" as const })),
        );
        const changeRequest = created._tag === "found" ? created.changeRequest : null;
        return {
          status: "created" as const,
          bookmarkName: input.bookmarkName,
          baseRefName,
          url: changeRequest?.url ?? null,
          number: changeRequest?.number ?? null,
        };
      }).pipe(Effect.mapError((cause) => mapError("create", cause))),
    );
  });

  return VcsChangeRequestService.of({
    create: (input) => create(input).pipe(Effect.mapError((cause) => mapError("create", cause))),
  });
});

export const layer = Layer.effect(VcsChangeRequestService, make);
