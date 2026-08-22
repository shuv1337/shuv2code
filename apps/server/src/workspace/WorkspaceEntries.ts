// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@shuv2code/contracts";
import { HostProcessPlatform } from "@shuv2code/shared/hostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@shuv2code/shared/path";
import { isWorkspaceImagePreviewPath } from "@shuv2code/shared/filePreview";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@shuv2code/shared/searchRanking";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedErrorClass<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedErrorClass<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedErrorClass<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("shuv2code/workspace/WorkspaceEntries") {}

const IGNORED_ENTRIES_CACHE_TTL_MS = 30_000;
const IGNORED_ENTRIES_MAX_ENTRIES = 25_000;
const IGNORED_ENTRIES_MAX_COLLECTED_ENTRIES = 100_000;
const IGNORED_ENTRIES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const IGNORED_ENTRIES_MAX_NESTED_REPOSITORIES = 64;

interface IgnoredEntriesResult {
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly prioritizedPaths: ReadonlySet<string>;
  readonly truncated: boolean;
}

interface GitListedEntriesResult {
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly nestedRepositoryPaths: ReadonlyArray<string>;
  readonly truncated: boolean;
}

function setEntry(entriesByPath: Map<string, ProjectEntry>, entry: ProjectEntry): void {
  const existing = entriesByPath.get(entry.path);
  if (!existing || (existing.kind === "file" && entry.kind === "directory")) {
    entriesByPath.set(entry.path, entry);
  }
}

function addPathAndAncestors(paths: Set<string>, entryPath: string): void {
  let currentPath = entryPath;
  while (currentPath.length > 0) {
    paths.add(currentPath);
    const separatorIndex = currentPath.lastIndexOf("/");
    if (separatorIndex < 0) break;
    currentPath = currentPath.slice(0, separatorIndex);
  }
}

function withDirectoryAncestors(entries: ReadonlyArray<ProjectEntry>): ProjectEntry[] {
  const entriesByPath = new Map<string, ProjectEntry>();
  for (const entry of entries) setEntry(entriesByPath, entry);
  for (const entry of entries) {
    let separatorIndex = entry.path.lastIndexOf("/");
    while (separatorIndex > 0) {
      const parentPath = entry.path.slice(0, separatorIndex);
      setEntry(entriesByPath, { path: parentPath, kind: "directory" });
      separatorIndex = parentPath.lastIndexOf("/");
    }
  }
  return [...entriesByPath.values()];
}

function mergeEntries(
  primary: ReadonlyArray<ProjectSearchEntriesResult["entries"][number]>,
  additional: ReadonlyArray<ProjectSearchEntriesResult["entries"][number]>,
) {
  const entriesByPath = new Map<string, ProjectEntry>();
  for (const entry of primary) setEntry(entriesByPath, entry);
  for (const entry of additional) setEntry(entriesByPath, entry);
  return [...entriesByPath.values()];
}

function scoreEntryPath(path: string, query: string): number | null {
  const normalizedPath = path.toLowerCase();
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const score = (value: string, offset: number) =>
    scoreQueryMatch({
      value,
      query,
      exactBase: offset,
      prefixBase: offset + 10,
      boundaryBase: offset + 20,
      includesBase: offset + 30,
      fuzzyBase: offset + 100,
    });
  const basenameScore = score(basename, 0);
  const pathScore = score(normalizedPath, 5);
  if (basenameScore === null) return pathScore;
  if (pathScore === null) return basenameScore;
  return Math.min(basenameScore, pathScore);
}

function mergeSearchEntries(
  primary: ProjectSearchEntriesResult,
  ignored: IgnoredEntriesResult,
  input: Pick<ProjectSearchEntriesInput, "imageOnly" | "kind" | "limit"> & {
    readonly query: string;
  },
): ProjectSearchEntriesResult {
  const filteredIgnoredEntries = ignored.entries.filter((entry) => {
    if (input.imageOnly) return entry.kind === "file" && isWorkspaceImagePreviewPath(entry.path);
    return input.kind === undefined || entry.kind === input.kind;
  });
  if (filteredIgnoredEntries.length === 0) {
    return ignored.truncated ? { ...primary, truncated: true } : primary;
  }

  const candidates = mergeEntries(primary.entries, filteredIgnoredEntries);
  if (input.query.length === 0) {
    const primaryPaths = new Set(primary.entries.map((entry) => entry.path));
    const isPrioritized = (entry: ProjectEntry) =>
      primaryPaths.has(entry.path) || ignored.prioritizedPaths.has(entry.path);
    const sorted = candidates.toSorted((left, right) => {
      const primaryDelta = Number(!isPrioritized(left)) - Number(!isPrioritized(right));
      return primaryDelta || left.path.localeCompare(right.path);
    });
    return {
      entries: sorted.slice(0, input.limit),
      truncated: primary.truncated || ignored.truncated || sorted.length > input.limit,
    };
  }

  const ranked: Array<{
    readonly item: ProjectSearchEntriesResult["entries"][number];
    readonly score: number;
    readonly tieBreaker: string;
  }> = [];
  for (const entry of candidates) {
    const score = scoreEntryPath(entry.path, input.query);
    if (score === null) continue;
    insertRankedSearchResult(
      ranked,
      { item: entry, score, tieBreaker: entry.path },
      input.limit + 1,
    );
  }
  return {
    entries: ranked.slice(0, input.limit).map(({ item }) => item),
    truncated: primary.truncated || ignored.truncated || ranked.length > input.limit,
  };
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, path));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(expandHomePath(input.cwd, path), input.partialPath);
});

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const ignoredEntriesCache = new Map<
    string,
    { readonly expiresAt: number; readonly result: IgnoredEntriesResult }
  >();

  const runGitPathListing = Effect.fn("WorkspaceEntries.runGitPathListing")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ): Effect.fn.Return<GitListedEntriesResult | null> {
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceEntries.listIgnored",
        command: "git",
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs: 15_000,
        maxOutputBytes: IGNORED_ENTRIES_MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.option);
    if (result._tag === "None" || result.value.exitCode !== 0) return null;

    const rawPaths = result.value.stdout.split("\0");
    if (result.value.stdoutTruncated) rawPaths.pop();
    const entries: ProjectEntry[] = [];
    const nestedRepositoryPaths: string[] = [];
    for (const rawPath of rawPaths) {
      const posixPath = rawPath.replaceAll("\\", "/");
      const isDirectory = posixPath.endsWith("/");
      const normalizedPath = isDirectory ? posixPath.replace(/\/+$/, "") : posixPath;
      if (!normalizedPath) continue;
      entries.push({ path: normalizedPath, kind: isDirectory ? "directory" : "file" });
      // Git reports an ignored embedded repository as one trailing-slash
      // directory instead of traversing it. Scan from that repository root so
      // repo-of-repos workspaces expose their actual files, not just a shell.
      if (isDirectory) nestedRepositoryPaths.push(normalizedPath);
    }
    return {
      entries,
      nestedRepositoryPaths,
      truncated: result.value.stdoutTruncated,
    };
  });

  const loadIgnoredEntries = Effect.fn("WorkspaceEntries.loadIgnoredEntries")(function* (
    cwd: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = ignoredEntriesCache.get(cwd);
    if (cached && cached.expiresAt > now) return cached.result;

    const rootListing = yield* runGitPathListing(cwd, [
      "ls-files",
      "--cached",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]);
    if (rootListing === null) {
      const emptyResult = {
        entries: [],
        prioritizedPaths: new Set<string>(),
        truncated: false,
      } satisfies IgnoredEntriesResult;
      ignoredEntriesCache.set(cwd, {
        expiresAt: now + IGNORED_ENTRIES_CACHE_TTL_MS,
        result: emptyResult,
      });
      return emptyResult;
    }

    const entriesByPath = new Map<string, ProjectEntry>();
    for (const entry of rootListing.entries) setEntry(entriesByPath, entry);
    const prioritizedPaths = new Set<string>();
    for (const nestedRepositoryPath of rootListing.nestedRepositoryPaths) {
      addPathAndAncestors(prioritizedPaths, nestedRepositoryPath);
    }
    const pendingRepositories = rootListing.nestedRepositoryPaths.map((relativePath) => ({
      cwd: path.join(cwd, relativePath),
      prefix: relativePath,
    }));
    const visitedRepositories = new Set<string>();
    let truncated = rootListing.truncated;

    while (
      pendingRepositories.length > 0 &&
      entriesByPath.size < IGNORED_ENTRIES_MAX_COLLECTED_ENTRIES &&
      visitedRepositories.size < IGNORED_ENTRIES_MAX_NESTED_REPOSITORIES
    ) {
      const repository = pendingRepositories.shift();
      if (!repository || visitedRepositories.has(repository.cwd)) continue;
      visitedRepositories.add(repository.cwd);
      const visibleListing = yield* runGitPathListing(repository.cwd, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      const ignoredListing = yield* runGitPathListing(repository.cwd, [
        "ls-files",
        "--cached",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ]);
      if (visibleListing === null && ignoredListing === null) continue;
      for (const [listing, prioritize] of [
        [visibleListing, true],
        [ignoredListing, false],
      ] as const) {
        if (listing === null) continue;
        truncated ||= listing.truncated;
        for (const entry of listing.entries) {
          const prefixedPath = `${repository.prefix}/${entry.path}`;
          setEntry(entriesByPath, { path: prefixedPath, kind: entry.kind });
          if (prioritize) addPathAndAncestors(prioritizedPaths, prefixedPath);
          if (entriesByPath.size >= IGNORED_ENTRIES_MAX_COLLECTED_ENTRIES) break;
        }
        for (const nestedPath of listing.nestedRepositoryPaths) {
          pendingRepositories.push({
            cwd: path.join(repository.cwd, nestedPath),
            prefix: `${repository.prefix}/${nestedPath}`,
          });
        }
      }
    }
    truncated ||=
      pendingRepositories.length > 0 || entriesByPath.size >= IGNORED_ENTRIES_MAX_COLLECTED_ENTRIES;
    const loadedResult = {
      entries: withDirectoryAncestors([...entriesByPath.values()]),
      prioritizedPaths,
      truncated,
    } satisfies IgnoredEntriesResult;
    ignoredEntriesCache.set(cwd, {
      expiresAt: now + IGNORED_ENTRIES_CACHE_TTL_MS,
      result: loadedResult,
    });
    return loadedResult;
  });

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      ignoredEntriesCache.delete(normalizedCwd);
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        const recoverRefreshFailure = (
          cause:
            | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
            | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
            | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
        ) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          });
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        const result = yield* searchIndex.search(
          normalizedQuery,
          input.limit,
          input.kind,
          input.imageOnly,
        );
        if (!input.includeIgnored) return result;
        const ignored = yield* loadIgnoredEntries(normalizedCwd);
        return mergeSearchEntries(result, ignored, { ...input, query: normalizedQuery });
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchContents(input);
    }).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
        ),
      ),
    );
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        const result = yield* searchIndex.list();
        if (!input.includeIgnored) return result;
        const ignored = yield* loadIgnoredEntries(normalizedCwd);
        // Preserve the primary index and nested-repository visible files ahead
        // of large ignored caches when bounding the tree payload.
        const mergedEntries = mergeEntries(result.entries, ignored.entries);
        const primaryPaths = new Set(result.entries.map((entry) => entry.path));
        const isPrioritized = (entry: ProjectEntry) =>
          primaryPaths.has(entry.path) || ignored.prioritizedPaths.has(entry.path);
        const entries = mergedEntries
          .toSorted((left, right) => {
            const priorityDelta = Number(!isPrioritized(left)) - Number(!isPrioritized(right));
            return priorityDelta || left.path.localeCompare(right.path);
          })
          .slice(0, IGNORED_ENTRIES_MAX_ENTRIES);
        return {
          entries,
          truncated:
            result.truncated ||
            ignored.truncated ||
            mergedEntries.length > IGNORED_ENTRIES_MAX_ENTRIES,
        };
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  return WorkspaceEntries.of({ browse, list, refresh, search, searchContents });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
);
