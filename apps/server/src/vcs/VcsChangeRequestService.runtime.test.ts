// @effect-diagnostics nodeBuiltinImport:off - verifies temporary body-file lifecycle.
/* oxlint-disable shuv2code/no-manual-effect-runtime-in-tests -- Independent runtime probe while the Effect/Vite+ adapter fails before collection. */
import * as NodeServices from "@effect/platform-node/NodeServices";
// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SourceControlProvider from "../sourceControl/SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsChangeRequestService from "./VcsChangeRequestService.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

it("pushes an explicit JJ bookmark before creating a provider change request", () => {
  const calls: string[] = [];
  let bodyFile = "";
  const driver = VcsDriver.VcsDriver.of({
    capabilities: {
      kind: "jj",
      supportsWorktrees: true,
      supportsBookmarks: true,
      supportsAtomicSnapshot: true,
      supportsPushDefaultRemote: false,
      supportsStatus: true,
      supportsRefMutation: true,
      supportsWorkspaceMutation: true,
      supportsDescribeChange: true,
      supportsStartChange: true,
      supportsFetch: true,
      supportsPush: true,
      supportsChangeRequests: true,
      supportsJuzu: true,
      ignoreClassifier: "git-compatible-fallback",
    },
    execute: () => Effect.die("unused"),
    detectRepository: () => Effect.die("unused"),
    isInsideWorkTree: () => Effect.die("unused"),
    listWorkspaceFiles: () => Effect.die("unused"),
    listRemotes: () => Effect.die("unused"),
    filterIgnoredPaths: () => Effect.die("unused"),
    initRepository: () => Effect.die("unused"),
    pushBookmark: (input) => {
      calls.push(`push:${input.bookmarkName}`);
      return Effect.succeed({
        status: "pushed" as const,
        bookmarkName: input.bookmarkName,
        remoteName: input.remoteName ?? null,
      });
    },
    listRefs: () =>
      Effect.succeed({
        refs: [
          {
            name: "main",
            kind: "bookmark" as const,
            current: false,
            isDefault: true,
            isRemote: false,
            worktreePath: null,
          },
        ],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 1,
      }),
  });
  let created = false;
  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests: () =>
      created
        ? Effect.succeed([
            {
              provider: "github" as const,
              number: 17,
              title: "Native JJ request",
              url: "https://github.com/example/repo/pull/17",
              baseRefName: "main",
              headRefName: "feature/native",
              state: "open" as const,
              updatedAt: Option.none(),
            },
          ])
        : Effect.succeed([]),
    createChangeRequest: (input) =>
      Effect.sync(() => {
        calls.push(`create:${input.headSelector}`);
        expect(input.source).toEqual({ refName: "feature/native", repository: "example/repo" });
        expect(input.target).toEqual({ refName: "main", repository: "example/repo" });
        expect(NodeFS.readFileSync(input.bodyFile, "utf8")).toBe("Body from JJ description");
        bodyFile = input.bodyFile;
        created = true;
      }),
    getChangeRequest: () => Effect.die("unused"),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    getDefaultBranch: () => Effect.succeed("main"),
    checkoutChangeRequest: () => Effect.die("unused"),
  });
  const layer = VcsChangeRequestService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () =>
          Effect.succeed({
            kind: "jj",
            repository: {
              kind: "jj",
              rootPath: "/repo",
              metadataPath: "/repo/.jj",
              freshness: {
                source: "live-local" as const,
                observedAt: DateTime.makeUnsafe("2026-08-05T00:00:00.000Z"),
                expiresAt: Option.none(),
              },
            },
            driver,
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveHandle: () =>
          Effect.succeed({
            provider,
            context: {
              provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
              remoteName: "origin",
              remoteUrl: "git@github.com:example/repo.git",
            },
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* VcsChangeRequestService.VcsChangeRequestService;
      const result = yield* service.create({
        cwd: "/repo",
        bookmarkName: "feature/native",
        remoteName: "origin",
        title: "Native JJ request",
        body: "Body from JJ description",
      });
      expect(calls).toEqual(["push:feature/native", "create:feature/native"]);
      expect(result).toMatchObject({ status: "created", baseRefName: "main", number: 17 });
      expect(NodeFS.existsSync(bodyFile)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
});
