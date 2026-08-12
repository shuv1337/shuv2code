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
import { SourceControlProviderError } from "@shuv2code/contracts";

import * as SourceControlProvider from "../sourceControl/SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsChangeRequestService from "./VcsChangeRequestService.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

function makeJjDriver(input: {
  readonly listRemotes?: VcsDriver.VcsDriver["Service"]["listRemotes"];
  readonly listRefs?: NonNullable<VcsDriver.VcsDriver["Service"]["listRefs"]>;
  readonly pushBookmark: NonNullable<VcsDriver.VcsDriver["Service"]["pushBookmark"]>;
}) {
  return VcsDriver.VcsDriver.of({
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
    listRemotes: input.listRemotes ?? (() => Effect.die("unused")),
    filterIgnoredPaths: () => Effect.die("unused"),
    initRepository: () => Effect.die("unused"),
    pushBookmark: input.pushBookmark,
    listRefs: input.listRefs ?? (() => Effect.die("unused")),
  });
}

function resolvedJjDriver(driver: VcsDriver.VcsDriver["Service"]) {
  return {
    kind: "jj" as const,
    repository: {
      kind: "jj" as const,
      rootPath: "/repo",
      metadataPath: "/repo/.jj",
      freshness: {
        source: "live-local" as const,
        observedAt: DateTime.makeUnsafe("2026-08-05T00:00:00.000Z"),
        expiresAt: Option.none(),
      },
    },
    driver,
  };
}

it("uses explicit selected-remote fetch and push coordinates without fallback", () => {
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
    listRemotes: () =>
      Effect.succeed({
        remotes: [
          {
            name: "origin",
            url: "git@github.com:example/primary.git",
            pushUrl: Option.none(),
            isPrimary: true,
          },
          {
            name: "upstream",
            url: "git@github.com:target/upstream.git",
            pushUrl: Option.some("git@github.com:fork/source.git"),
            isPrimary: false,
          },
        ],
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.makeUnsafe("2026-08-05T00:00:00.000Z"),
          expiresAt: Option.none(),
        },
      }),
    filterIgnoredPaths: () => Effect.die("unused"),
    initRepository: () => Effect.die("unused"),
    pushBookmark: (input) => {
      calls.push(`push:${input.remoteName ?? "default"}:${input.bookmarkName}`);
      return Effect.succeed({
        status: "pushed" as const,
        bookmarkName: input.bookmarkName,
        remoteName: input.remoteName ?? null,
      });
    },
    listRefs: () => Effect.die("explicit selected remote must not read cwd/default refs"),
  });
  let created = false;
  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests: (input) =>
      Effect.sync(() => {
        calls.push(
          `list:${input.context?.remoteName ?? "missing"}:${input.source?.repository ?? "missing"}`,
        );
        expect(input.context?.remoteUrl).toBe("git@github.com:target/upstream.git");
        expect(input.source).toEqual({
          refName: "feature/native",
          repository: "fork/source",
        });
        return created
          ? [
              {
                provider: "github" as const,
                number: 16,
                title: "Wrong base request",
                url: "https://github.com/target/upstream/pull/16",
                baseRefName: "main",
                headRefName: "feature/native",
                state: "open" as const,
                updatedAt: Option.none(),
              },
              {
                provider: "github" as const,
                number: 17,
                title: "Native JJ request",
                url: "https://github.com/target/upstream/pull/17",
                baseRefName: "develop",
                headRefName: "feature/native",
                state: "open" as const,
                updatedAt: Option.none(),
              },
            ]
          : [];
      }),
    createChangeRequest: (input) =>
      Effect.sync(() => {
        calls.push(`create:${input.context?.remoteName ?? "missing"}:${input.headSelector}`);
        expect(input.context?.remoteUrl).toBe("git@github.com:target/upstream.git");
        expect(input.source).toEqual({
          refName: "feature/native",
          repository: "fork/source",
        });
        expect(input.target).toEqual({
          refName: "develop",
          repository: "target/upstream",
        });
        expect(NodeFS.readFileSync(input.bodyFile, "utf8")).toBe("Body from JJ description");
        bodyFile = input.bodyFile;
        created = true;
      }),
    getChangeRequest: () => Effect.die("unused"),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    getDefaultBranch: (input) =>
      Effect.sync(() => {
        calls.push(`default:${input.context?.remoteName ?? "missing"}`);
        expect(input.context?.remoteUrl).toBe("git@github.com:target/upstream.git");
        return "develop";
      }),
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
        resolveRemoteHandle: (input) =>
          Effect.sync(() => {
            expect(input).toEqual({
              cwd: "/repo",
              remoteName: "upstream",
              remoteUrl: "git@github.com:target/upstream.git",
            });
            calls.push(`provider:${input.remoteName}:${input.remoteUrl}`);
            return {
              provider,
              context: {
                provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
                remoteName: input.remoteName,
                remoteUrl: input.remoteUrl,
              },
            };
          }),
        resolveHandle: () => Effect.die("selected remote must not use the primary provider handle"),
        get: () => Effect.die("selected remote must not use provider-kind fallback"),
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
        remoteName: "upstream",
        title: "Native JJ request",
        body: "Body from JJ description",
      });
      expect(calls).toEqual([
        "provider:upstream:git@github.com:target/upstream.git",
        "default:upstream",
        "push:upstream:feature/native",
        "list:upstream:fork/source",
        "create:upstream:feature/native",
        "list:upstream:fork/source",
      ]);
      expect(result).toMatchObject({ status: "created", baseRefName: "develop", number: 17 });
      expect(NodeFS.existsSync(bodyFile)).toBe(false);

      calls.length = 0;
      const existing = yield* service.create({
        cwd: "/repo",
        bookmarkName: "feature/native",
        remoteName: "upstream",
        title: "Native JJ request",
        body: "Updated body from JJ description",
      });
      expect(calls).toEqual([
        "provider:upstream:git@github.com:target/upstream.git",
        "default:upstream",
        "push:upstream:feature/native",
        "list:upstream:fork/source",
      ]);
      expect(existing).toMatchObject({
        status: "opened_existing",
        baseRefName: "develop",
        number: 17,
      });
    }).pipe(Effect.provide(layer)),
  );
});

it("uses the exact implicit remote push URL for fork source coordinates", () => {
  const calls: string[] = [];
  const driver = makeJjDriver({
    listRemotes: () =>
      Effect.sync(() => {
        calls.push("remotes");
        return {
          remotes: [
            {
              name: "origin",
              url: "git@github.com:example/other.git",
              pushUrl: Option.none(),
              isPrimary: true,
            },
            {
              name: "upstream",
              url: "git@github.com:upstream/project.git",
              pushUrl: Option.some("git@github.com:fork/project.git"),
              isPrimary: false,
            },
          ],
          freshness: {
            source: "live-local" as const,
            observedAt: DateTime.makeUnsafe("2026-08-05T00:00:00.000Z"),
            expiresAt: Option.none(),
          },
        };
      }),
    pushBookmark: (input) =>
      Effect.sync(() => {
        calls.push(`push:${input.remoteName ?? "missing"}`);
        return {
          status: "pushed" as const,
          bookmarkName: input.bookmarkName,
          remoteName: input.remoteName ?? null,
        };
      }),
    listRefs: () =>
      Effect.sync(() => {
        calls.push("refs");
        return {
          refs: [],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 0,
        };
      }),
  });
  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests: (input) =>
      Effect.sync(() => {
        calls.push(
          `list:${input.context?.remoteName ?? "missing"}:${input.source?.repository ?? "missing"}`,
        );
        expect(input.context?.remoteUrl).toBe("git@github.com:upstream/project.git");
        expect(input.source).toEqual({
          refName: "feature/native",
          repository: "fork/project",
        });
        return [];
      }),
    createChangeRequest: (input) =>
      Effect.sync(() => {
        calls.push("create");
        expect(input.context?.remoteUrl).toBe("git@github.com:upstream/project.git");
        expect(input.source).toEqual({
          refName: "feature/native",
          repository: "fork/project",
        });
        expect(input.target).toEqual({
          refName: "main",
          repository: "upstream/project",
        });
      }),
    getChangeRequest: () => Effect.die("unused"),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    getDefaultBranch: () => Effect.die("unused"),
    checkoutChangeRequest: () => Effect.die("unused"),
  });
  const layer = VcsChangeRequestService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () => Effect.succeed(resolvedJjDriver(driver)),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveHandle: () =>
          Effect.sync(() => {
            calls.push("resolve:upstream");
            return {
              provider,
              context: {
                provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
                remoteName: "upstream",
                remoteUrl: "git@github.com:upstream/project.git",
              },
            };
          }),
        resolveRemoteHandle: () => Effect.die("no explicit remote was requested"),
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
        baseRefName: "main",
        title: "Fork request",
        body: "Body",
      });

      expect(calls).toEqual([
        "resolve:upstream",
        "remotes",
        "refs",
        "push:upstream",
        "list:upstream:fork/project",
        "create",
        "list:upstream:fork/project",
      ]);
      expect(result).toEqual({
        status: "created",
        bookmarkName: "feature/native",
        baseRefName: "main",
        url: null,
        number: null,
      });
    }).pipe(Effect.provide(layer)),
  );
});

it("refreshes a cached implicit provider when the selected remote URL changed", () => {
  const calls: string[] = [];
  const currentRemoteUrl = "git@github.com:current/target.git";
  const driver = makeJjDriver({
    listRemotes: () =>
      Effect.sync(() => {
        calls.push("remotes:current");
        return {
          remotes: [
            {
              name: "upstream",
              url: currentRemoteUrl,
              pushUrl: Option.some("git@github.com:fork/source.git"),
              isPrimary: true,
            },
          ],
          freshness: {
            source: "live-local" as const,
            observedAt: DateTime.makeUnsafe("2026-08-05T00:00:00.000Z"),
            expiresAt: Option.none(),
          },
        };
      }),
    pushBookmark: (input) =>
      Effect.sync(() => {
        expect(input.remoteName).toBe("upstream");
        calls.push(`push:${input.remoteName ?? "missing"}`);
        return {
          status: "pushed" as const,
          bookmarkName: input.bookmarkName,
          remoteName: input.remoteName ?? null,
        };
      }),
    listRefs: () =>
      Effect.sync(() => {
        calls.push("refs");
        return {
          refs: [],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 0,
        };
      }),
  });
  const staleProvider = SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests: () => Effect.die("stale provider must not list change requests"),
    createChangeRequest: () => Effect.die("stale provider must not create a change request"),
    getChangeRequest: () => Effect.die("unused"),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    getDefaultBranch: () => Effect.die("stale provider must not resolve the target branch"),
    checkoutChangeRequest: () => Effect.die("unused"),
  });
  let created = false;
  const currentProvider = SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests: (input) =>
      Effect.sync(() => {
        expect(input.context?.remoteUrl).toBe(currentRemoteUrl);
        expect(input.source).toEqual({
          refName: "feature/native",
          repository: "fork/source",
        });
        calls.push(`list:${input.context?.remoteUrl}:${input.source?.repository}`);
        return created
          ? [
              {
                provider: "github" as const,
                number: 21,
                title: "Current target request",
                url: "https://github.com/current/target/pull/21",
                baseRefName: "main",
                headRefName: "feature/native",
                state: "open" as const,
                updatedAt: Option.none(),
              },
            ]
          : [];
      }),
    createChangeRequest: (input) =>
      Effect.sync(() => {
        expect(input.context?.remoteUrl).toBe(currentRemoteUrl);
        expect(input.source).toEqual({
          refName: "feature/native",
          repository: "fork/source",
        });
        expect(input.target).toEqual({
          refName: "main",
          repository: "current/target",
        });
        calls.push(`create:${input.context?.remoteUrl}`);
        created = true;
      }),
    getChangeRequest: () => Effect.die("unused"),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    getDefaultBranch: (input) =>
      Effect.sync(() => {
        expect(input.context?.remoteUrl).toBe(currentRemoteUrl);
        calls.push(`default:${input.context?.remoteUrl}`);
        return "main";
      }),
    checkoutChangeRequest: () => Effect.die("unused"),
  });
  const layer = VcsChangeRequestService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () => Effect.succeed(resolvedJjDriver(driver)),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveHandle: () =>
          Effect.sync(() => {
            calls.push("resolve:cached");
            return {
              provider: staleProvider,
              context: {
                provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
                remoteName: "upstream",
                remoteUrl: "git@github.com:stale/target.git",
              },
            };
          }),
        resolveRemoteHandle: (input) =>
          Effect.sync(() => {
            expect(input).toEqual({
              cwd: "/repo",
              remoteName: "upstream",
              remoteUrl: currentRemoteUrl,
            });
            calls.push(`refresh:${input.remoteName}:${input.remoteUrl}`);
            return {
              provider: currentProvider,
              context: {
                provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
                remoteName: input.remoteName,
                remoteUrl: input.remoteUrl,
              },
            };
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
        title: "Current target request",
        body: "Body",
      });

      expect(calls).toEqual([
        "resolve:cached",
        "remotes:current",
        `refresh:upstream:${currentRemoteUrl}`,
        "refs",
        `default:${currentRemoteUrl}`,
        "push:upstream",
        `list:${currentRemoteUrl}:fork/source`,
        `create:${currentRemoteUrl}`,
        `list:${currentRemoteUrl}:fork/source`,
      ]);
      expect(result).toEqual({
        status: "created",
        bookmarkName: "feature/native",
        baseRefName: "main",
        url: "https://github.com/current/target/pull/21",
        number: 21,
      });
    }).pipe(Effect.provide(layer)),
  );
});

it("rejects a cross-host push URL before publishing or querying change requests", () => {
  let pushed = false;
  const driver = makeJjDriver({
    listRemotes: () =>
      Effect.succeed({
        remotes: [
          {
            name: "upstream",
            url: "https://github.enterprise-one.test/target/project.git",
            pushUrl: Option.some("git@github.enterprise-two.test:fork/project.git"),
            isPrimary: true,
          },
        ],
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.makeUnsafe("2026-08-05T00:00:00.000Z"),
          expiresAt: Option.none(),
        },
      }),
    pushBookmark: () =>
      Effect.sync(() => {
        pushed = true;
        return {
          status: "pushed" as const,
          bookmarkName: "feature/native",
          remoteName: "upstream",
        };
      }),
  });
  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests: () => Effect.die("cross-host source must not be queried"),
    createChangeRequest: () => Effect.die("cross-host source must not be created"),
    getChangeRequest: () => Effect.die("unused"),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    getDefaultBranch: () => Effect.die("unused"),
    checkoutChangeRequest: () => Effect.die("unused"),
  });
  const layer = VcsChangeRequestService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () => Effect.succeed(resolvedJjDriver(driver)),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveHandle: () => Effect.die("explicit remote must not use the cached handle"),
        resolveRemoteHandle: (input) =>
          Effect.succeed({
            provider,
            context: {
              provider: {
                kind: "github",
                name: "GitHub Self-Hosted",
                baseUrl: "https://github.enterprise-one.test",
              },
              remoteName: input.remoteName,
              remoteUrl: input.remoteUrl,
            },
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* VcsChangeRequestService.VcsChangeRequestService;
      const error = yield* service
        .create({
          cwd: "/repo",
          bookmarkName: "feature/native",
          remoteName: "upstream",
          baseRefName: "main",
          title: "Cross-host request",
          body: "Body",
        })
        .pipe(Effect.flip);

      expect(error.detail).toContain("not on the selected source-control host");
      expect(pushed).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
});

it("shares one exact create outcome across concurrent identical requests", () => {
  let pushCalls = 0;
  let listCalls = 0;
  let createCalls = 0;
  let created = false;
  const driver = makeJjDriver({
    listRemotes: () =>
      Effect.succeed({
        remotes: [
          {
            name: "origin",
            url: "git@github.com:example/project.git",
            pushUrl: Option.none(),
            isPrimary: true,
          },
        ],
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.makeUnsafe("2026-08-05T00:00:00.000Z"),
          expiresAt: Option.none(),
        },
      }),
    pushBookmark: (input) =>
      Effect.sync(() => {
        pushCalls += 1;
        return {
          status: "pushed" as const,
          bookmarkName: input.bookmarkName,
          remoteName: input.remoteName ?? null,
        };
      }),
  });
  const exact = {
    provider: "github" as const,
    number: 31,
    title: "Concurrent request",
    url: "https://github.com/example/project/pull/31",
    baseRefName: "main",
    headRefName: "feature/native",
    state: "open" as const,
    updatedAt: Option.none(),
  };
  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests: () =>
      Effect.sync(() => {
        listCalls += 1;
        return created ? [exact] : [];
      }),
    createChangeRequest: () =>
      Effect.gen(function* () {
        createCalls += 1;
        yield* Effect.sleep("25 millis");
        created = true;
      }),
    getChangeRequest: () => Effect.die("unused"),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    getDefaultBranch: () => Effect.die("unused"),
    checkoutChangeRequest: () => Effect.die("unused"),
  });
  const layer = VcsChangeRequestService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () => Effect.succeed(resolvedJjDriver(driver)),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveHandle: () => Effect.die("explicit remote must not use the cached handle"),
        resolveRemoteHandle: (input) =>
          Effect.succeed({
            provider,
            context: {
              provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
              remoteName: input.remoteName,
              remoteUrl: input.remoteUrl,
            },
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const request = {
    cwd: "/repo",
    bookmarkName: "feature/native",
    remoteName: "origin",
    baseRefName: "main",
    title: "Concurrent request",
    body: "Body",
  } as const;

  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* VcsChangeRequestService.VcsChangeRequestService;
      const results = yield* Effect.all([service.create(request), service.create(request)], {
        concurrency: "unbounded",
      });

      expect(results).toEqual([
        {
          status: "created",
          bookmarkName: "feature/native",
          baseRefName: "main",
          url: exact.url,
          number: 31,
        },
        {
          status: "created",
          bookmarkName: "feature/native",
          baseRefName: "main",
          url: exact.url,
          number: 31,
        },
      ]);
      expect(pushCalls).toBe(1);
      expect(listCalls).toBe(2);
      expect(createCalls).toBe(1);
    }).pipe(Effect.provide(layer)),
  );
});

it("reconciles an ambiguous typed create failure to the exact created request", () => {
  let listCalls = 0;
  let createCalls = 0;
  const driver = makeJjDriver({
    listRemotes: () =>
      Effect.succeed({
        remotes: [
          {
            name: "origin",
            url: "git@github.com:example/project.git",
            pushUrl: Option.none(),
            isPrimary: true,
          },
        ],
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.makeUnsafe("2026-08-05T00:00:00.000Z"),
          expiresAt: Option.none(),
        },
      }),
    pushBookmark: (input) =>
      Effect.succeed({
        status: "pushed" as const,
        bookmarkName: input.bookmarkName,
        remoteName: input.remoteName ?? null,
      }),
  });
  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests: () =>
      Effect.sync(() => {
        listCalls += 1;
        return listCalls === 1
          ? []
          : [
              {
                provider: "github" as const,
                number: 41,
                title: "Recovered request",
                url: "https://github.com/example/project/pull/41",
                baseRefName: "main",
                headRefName: "feature/native",
                state: "open" as const,
                updatedAt: Option.none(),
              },
            ];
      }),
    createChangeRequest: () => {
      createCalls += 1;
      return Effect.fail(
        new SourceControlProviderError({
          provider: "github",
          operation: "createChangeRequest",
          cwd: "/repo",
          detail: "connection closed before the provider response",
        }),
      );
    },
    getChangeRequest: () => Effect.die("unused"),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    getDefaultBranch: () => Effect.die("unused"),
    checkoutChangeRequest: () => Effect.die("unused"),
  });
  const layer = VcsChangeRequestService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () => Effect.succeed(resolvedJjDriver(driver)),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveHandle: () => Effect.die("explicit remote must not use the cached handle"),
        resolveRemoteHandle: (input) =>
          Effect.succeed({
            provider,
            context: {
              provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
              remoteName: input.remoteName,
              remoteUrl: input.remoteUrl,
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
        baseRefName: "main",
        title: "Recovered request",
        body: "Body",
      });

      expect(result).toEqual({
        status: "created",
        bookmarkName: "feature/native",
        baseRefName: "main",
        url: "https://github.com/example/project/pull/41",
        number: 41,
      });
      expect(listCalls).toBe(2);
      expect(createCalls).toBe(1);
    }).pipe(Effect.provide(layer)),
  );
});

it("fails closed before creation but preserves success after a post-create lookup failure", () => {
  const calls: string[] = [];
  let mode: "pre-create-failure" | "post-create-failure" = "pre-create-failure";
  let listCall = 0;
  let createdBodyFile = "";
  const driver = makeJjDriver({
    listRemotes: () =>
      Effect.succeed({
        remotes: [
          {
            name: "origin",
            url: "git@github.com:example/repo.git",
            pushUrl: Option.none(),
            isPrimary: true,
          },
        ],
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.makeUnsafe("2026-08-05T00:00:00.000Z"),
          expiresAt: Option.none(),
        },
      }),
    pushBookmark: (input) =>
      Effect.sync(() => {
        calls.push(`push:${input.remoteName ?? "missing"}`);
        return {
          status: "pushed" as const,
          bookmarkName: input.bookmarkName,
          remoteName: input.remoteName ?? null,
        };
      }),
    listRefs: () =>
      Effect.succeed({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 0,
      }),
  });
  const preCreateCause = new SourceControlProviderError({
    provider: "github",
    operation: "listChangeRequests",
    cwd: "/repo",
    detail: "provider lookup unavailable",
  });
  const postCreateCause = new SourceControlProviderError({
    provider: "github",
    operation: "listChangeRequests",
    cwd: "/repo",
    detail: "created request metadata unavailable",
  });
  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests: () => {
      listCall += 1;
      calls.push(`list:${mode}:${listCall}`);
      if (mode === "pre-create-failure") {
        return Effect.fail(preCreateCause);
      }
      return listCall === 1 ? Effect.succeed([]) : Effect.fail(postCreateCause);
    },
    createChangeRequest: (input) =>
      Effect.sync(() => {
        calls.push("create");
        expect(NodeFS.readFileSync(input.bodyFile, "utf8")).toBe("Body");
        createdBodyFile = input.bodyFile;
      }),
    getChangeRequest: () => Effect.die("unused"),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    getDefaultBranch: () => Effect.die("unused"),
    checkoutChangeRequest: () => Effect.die("unused"),
  });
  const layer = VcsChangeRequestService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () => Effect.succeed(resolvedJjDriver(driver)),
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
        resolveRemoteHandle: () => Effect.die("no explicit remote was requested"),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* VcsChangeRequestService.VcsChangeRequestService;
      const error = yield* service
        .create({
          cwd: "/repo",
          bookmarkName: "feature/native",
          baseRefName: "main",
          title: "Request",
          body: "Body",
        })
        .pipe(Effect.flip);

      expect(error.cause).toBe(preCreateCause);
      expect(calls).toEqual(["push:origin", "list:pre-create-failure:1"]);

      calls.length = 0;
      listCall = 0;
      mode = "post-create-failure";
      const result = yield* service.create({
        cwd: "/repo",
        bookmarkName: "feature/native",
        baseRefName: "main",
        title: "Request",
        body: "Body",
      });

      expect(calls).toEqual([
        "push:origin",
        "list:post-create-failure:1",
        "create",
        "list:post-create-failure:2",
      ]);
      expect(result).toEqual({
        status: "created",
        bookmarkName: "feature/native",
        baseRefName: "main",
        url: null,
        number: null,
      });
      expect(NodeFS.existsSync(createdBodyFile)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
});
