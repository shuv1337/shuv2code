import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  SourceControlRepositoryError,
  type VcsCreateChangeRequestInput,
  type VcsCreateChangeRequestResult,
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

    const providerHandle = yield* providers.resolveHandle({ cwd: input.cwd });
    if (providerHandle.context === null || providerHandle.provider.kind === "unknown") {
      return yield* new SourceControlRepositoryError({
        operation: "createChangeRequest",
        provider: "unknown",
        detail: "No supported source-control provider was detected for the JJ remote.",
      });
    }
    const repository = repositoryPathFromRemoteUrl(providerHandle.context.remoteUrl);
    const source = {
      refName: input.bookmarkName,
      ...(repository ? { repository } : {}),
    };

    const refs = yield* handle.driver.listRefs({ cwd: input.cwd, limit: 200 });
    const detectedBase = refs.refs.find((ref) => ref.isDefault)?.name ?? null;
    const providerDefault =
      input.baseRefName || detectedBase
        ? null
        : yield* providerHandle.provider
            .getDefaultBranch({ cwd: input.cwd })
            .pipe(Effect.orElseSucceed(() => null));
    const baseRefName = input.baseRefName ?? detectedBase ?? providerDefault;
    if (!baseRefName) {
      return yield* new SourceControlRepositoryError({
        operation: "createChangeRequest",
        provider: providerHandle.provider.kind,
        detail: "Choose a target bookmark before creating the change request.",
      });
    }

    const existing = yield* providerHandle.provider
      .listChangeRequests({
        cwd: input.cwd,
        source,
        headSelector: input.bookmarkName,
        state: "open",
        limit: 1,
      })
      .pipe(Effect.orElseSucceed(() => []));
    const open = existing[0];
    if (open) {
      return {
        status: "opened_existing" as const,
        bookmarkName: input.bookmarkName,
        baseRefName: open.baseRefName,
        url: open.url,
        number: open.number,
      };
    }

    yield* handle.driver.pushBookmark({
      cwd: input.cwd,
      bookmarkName: input.bookmarkName,
      ...(input.remoteName ? { remoteName: input.remoteName } : {}),
    });

    const bodyFile = path.join(
      NodeOS.tmpdir(),
      `shuv2code-change-request-${NodeCrypto.randomUUID()}.md`,
    );
    yield* fileSystem.writeFileString(bodyFile, input.body);
    yield* providerHandle.provider
      .createChangeRequest({
        cwd: input.cwd,
        source,
        ...(repository ? { target: { refName: baseRefName, repository } } : {}),
        baseRefName,
        headSelector: input.bookmarkName,
        title: input.title,
        bodyFile,
      })
      .pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))));

    const created = yield* providerHandle.provider
      .listChangeRequests({
        cwd: input.cwd,
        source,
        headSelector: input.bookmarkName,
        state: "open",
        limit: 1,
      })
      .pipe(Effect.orElseSucceed(() => []));
    const changeRequest = created[0];
    return {
      status: "created" as const,
      bookmarkName: input.bookmarkName,
      baseRefName,
      url: changeRequest?.url ?? null,
      number: changeRequest?.number ?? null,
    };
  });

  return VcsChangeRequestService.of({
    create: (input) => create(input).pipe(Effect.mapError((cause) => mapError("create", cause))),
  });
});

export const layer = Layer.effect(VcsChangeRequestService, make);
