import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type VcsCreateRefResult,
  type VcsCreateWorktreeResult,
  type VcsDescribeChangeResult,
  type VcsFetchResult,
  type VcsListRefsResult,
  type VcsPushBookmarkResult,
  type VcsStartChangeResult,
  type VcsStatusResult,
  type VcsSwitchRefResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type VcsError,
} from "@shuv2code/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@shuv2code/shared/sourceControl";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const JJ_STATUS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const RawJjCommit = Schema.Struct({
  commitId: Schema.String,
  changeId: Schema.String,
  description: Schema.String,
  empty: Schema.Boolean,
  conflict: Schema.Boolean,
  conflictPaths: Schema.Array(Schema.String),
});
type RawJjCommit = typeof RawJjCommit.Type;

const RawJjBookmark = Schema.Struct({
  name: Schema.String,
  remote: Schema.optional(Schema.String),
  target: Schema.Array(Schema.String),
  tracking_target: Schema.optional(Schema.Array(Schema.String)),
});
type RawJjBookmark = typeof RawJjBookmark.Type;

const RawJjWorkspace = Schema.Struct({
  name: Schema.String,
  target: Schema.Struct({
    commit_id: Schema.String,
  }),
});

const RawJjDiffEntry = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  conflict: Schema.Boolean,
});
type RawJjDiffEntry = typeof RawJjDiffEntry.Type;

const decodeRawJjCommit = Schema.decodeUnknownEffect(Schema.fromJsonString(RawJjCommit));
const decodeRawJjBookmark = Schema.decodeUnknownEffect(Schema.fromJsonString(RawJjBookmark));
const decodeRawJjWorkspace = Schema.decodeUnknownEffect(Schema.fromJsonString(RawJjWorkspace));
const decodeRawJjDiffEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(RawJjDiffEntry));

const JJ_COMMIT_TEMPLATE =
  '"{" ++ "\\"commitId\\":" ++ json(commit_id) ++ ",\\"changeId\\":" ++ json(change_id) ++ ",\\"description\\":" ++ json(description) ++ ",\\"empty\\":" ++ json(empty) ++ ",\\"conflict\\":" ++ json(conflict) ++ ",\\"conflictPaths\\":" ++ json(conflicted_files.map(|entry| entry.path())) ++ "}\\n"';
const JJ_DIFF_ENTRY_TEMPLATE =
  '"{" ++ "\\"path\\":" ++ json(path) ++ ",\\"status\\":" ++ json(status) ++ ",\\"conflict\\":" ++ json(target.conflict()) ++ "}\\n"';

function sanitizeWorkspaceName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized.length > 0 ? sanitized : "workspace";
}

const nowFreshness = Effect.fn("JjVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const paths = input.split("\0");
  if (truncated && paths.at(-1)?.length) {
    paths.pop();
  }
  return paths.filter((path) => path.length > 0);
}

function chunkPaths(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const pathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + pathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(relativePath);
    chunkBytes += pathBytes;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function diffHash(diff: string): string {
  return NodeCrypto.createHash("sha256").update(diff, "utf8").digest("hex");
}

export const makeVcsDriver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;

  const staticCapabilities = {
    kind: "jj" as const,
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
    supportsJuzu: false,
    ignoreClassifier: "git-compatible-fallback" as const,
  };

  const runJj = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      readonly appendTruncationMarker?: boolean;
      readonly ignoreWorkingCopy?: boolean;
    },
  ) =>
    process.run({
      operation,
      command: "jj",
      args: [
        "--no-pager",
        "--color",
        "never",
        ...(options?.ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
        "-R",
        cwd,
        ...args,
      ],
      cwd,
      spawnCwd: globalThis.process.cwd(),
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options?.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
    });

  const runGit = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      readonly appendTruncationMarker?: boolean;
    },
  ) =>
    process.run({
      operation,
      command: "git",
      args: ["-C", cwd, ...args],
      cwd,
      spawnCwd: globalThis.process.cwd(),
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options?.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
    });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "JjVcsDriver.detectRepository",
  )(function* (cwd) {
    const result = yield* runJj("JjVcsDriver.detectRepository", cwd, ["root"], {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 8_192,
      ignoreWorkingCopy: true,
    });
    const rootPath = result.stdout.trim();
    if (result.exitCode !== 0 || rootPath.length === 0) {
      return null;
    }
    return {
      kind: "jj" as const,
      rootPath,
      metadataPath: path.join(rootPath, ".jj"),
      freshness: yield* nowFreshness(),
    };
  });

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    detectRepository(cwd).pipe(Effect.map((repository) => repository !== null));

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    runJj(input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = Effect.fn(
    "JjVcsDriver.listWorkspaceFiles",
  )(function* (cwd) {
    const result = yield* runJj(
      "JjVcsDriver.listWorkspaceFiles",
      cwd,
      ["file", "list", "-T", 'path ++ "\\0"'],
      {
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );
    return {
      paths: splitNullSeparatedPaths(result.stdout, result.stdoutTruncated),
      truncated: result.stdoutTruncated,
      freshness: yield* nowFreshness(),
    };
  });

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn(
    "JjVcsDriver.listRemotes",
  )(function* (cwd) {
    const result = yield* runJj("JjVcsDriver.listRemotes", cwd, ["git", "remote", "list"], {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
      ignoreWorkingCopy: true,
    });
    const parsed = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        const separator = line.search(/\s/);
        if (separator <= 0) return [];
        return [{ name: line.slice(0, separator), url: line.slice(separator).trim() }];
      });
    const primaryName = parsed.some((remote) => remote.name === "origin")
      ? "origin"
      : (parsed[0]?.name ?? null);
    return {
      remotes: parsed.map((remote) => ({
        ...remote,
        pushUrl: Option.none<string>(),
        isPrimary: remote.name === primaryName,
      })),
      freshness: yield* nowFreshness(),
    };
  });

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "JjVcsDriver.filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) return relativePaths;

    const ignored = new Set<string>();
    for (const chunk of chunkPaths(relativePaths)) {
      const result = yield* runGit(
        "JjVcsDriver.filterIgnoredPaths",
        cwd,
        ["check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation: "JjVcsDriver.filterIgnoredPaths",
          command: "git check-ignore",
          cwd,
          exitCode: result.exitCode,
          detail:
            "Ignored-path classification requires a colocated jj/Git workspace (the default created by shuv2code).",
        });
      }
      for (const ignoredPath of splitNullSeparatedPaths(result.stdout, result.stdoutTruncated)) {
        ignored.add(ignoredPath);
      }
    }
    return relativePaths.filter((relativePath) => !ignored.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (input) =>
    process
      .run({
        operation: "JjVcsDriver.initRepository",
        command: "jj",
        args: ["--no-pager", "--color", "never", "git", "init", "--colocate", input.cwd],
        cwd: input.cwd,
        spawnCwd: globalThis.process.cwd(),
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024,
      })
      .pipe(Effect.asVoid);

  const structuredOutputError = (operation: string, cwd: string) =>
    new VcsProcessExitError({
      operation,
      command: "jj structured template",
      cwd,
      exitCode: 1,
      detail: "Jujutsu returned invalid structured output.",
    });

  const mapFileSystemError = (operation: string, detail: string) =>
    Effect.mapError(
      (cause: unknown) =>
        new VcsUnsupportedOperationError({
          operation,
          kind: "jj",
          detail: `${detail}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    );

  const readWorkingCopyCommit = Effect.fn("JjVcsDriver.readWorkingCopyCommit")(function* (
    cwd: string,
    revision = "@",
  ) {
    const operation = "JjVcsDriver.readWorkingCopyCommit";
    const result = yield* runJj(
      operation,
      cwd,
      ["log", "--no-graph", "-r", revision, "-T", JJ_COMMIT_TEMPLATE],
      { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
    );
    return yield* decodeRawJjCommit(result.stdout.trim()).pipe(
      Effect.mapError(() => structuredOutputError(operation, cwd)),
    );
  });

  const readDiffEntries = Effect.fn("JjVcsDriver.readDiffEntries")(function* (cwd: string) {
    const operation = "JjVcsDriver.readDiffEntries";
    const result = yield* runJj(operation, cwd, ["diff", "-r", "@", "-T", JJ_DIFF_ENTRY_TEMPLATE], {
      timeoutMs: 20_000,
      maxOutputBytes: JJ_STATUS_MAX_OUTPUT_BYTES,
    });
    return yield* Effect.forEach(
      result.stdout.split("\n").filter((line) => line.trim().length > 0),
      (line) =>
        decodeRawJjDiffEntry(line).pipe(
          Effect.mapError(() => structuredOutputError(operation, cwd)),
        ),
    );
  });

  const readBookmarks = Effect.fn("JjVcsDriver.readBookmarks")(function* (cwd: string) {
    const operation = "JjVcsDriver.readBookmarks";
    const result = yield* runJj(
      operation,
      cwd,
      ["bookmark", "list", "--all-remotes", "-T", 'json(self) ++ "\\n"'],
      { timeoutMs: 20_000, maxOutputBytes: JJ_STATUS_MAX_OUTPUT_BYTES },
    );
    return yield* Effect.forEach(
      result.stdout.split("\n").filter((line) => line.trim().length > 0),
      (line) =>
        decodeRawJjBookmark(line).pipe(
          Effect.mapError(() => structuredOutputError(operation, cwd)),
        ),
    );
  });

  const readWorkspaces = Effect.fn("JjVcsDriver.readWorkspaces")(function* (cwd: string) {
    const operation = "JjVcsDriver.readWorkspaces";
    const result = yield* runJj(
      operation,
      cwd,
      ["workspace", "list", "-T", 'json(self) ++ "\\n"'],
      { timeoutMs: 10_000, maxOutputBytes: 512 * 1024, ignoreWorkingCopy: true },
    );
    return yield* Effect.forEach(
      result.stdout.split("\n").filter((line) => line.trim().length > 0),
      (line) =>
        decodeRawJjWorkspace(line).pipe(
          Effect.mapError(() => structuredOutputError(operation, cwd)),
        ),
    );
  });

  const readRevisionCommitId = Effect.fn("JjVcsDriver.readRevisionCommitId")(function* (
    cwd: string,
    revision: string,
  ) {
    const result = yield* runJj(
      "JjVcsDriver.readRevisionCommitId",
      cwd,
      ["log", "--no-graph", "-r", revision, "-T", 'commit_id ++ "\\n"'],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 8_192,
        ignoreWorkingCopy: true,
      },
    );
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  });

  const readCommitDistance = Effect.fn("JjVcsDriver.readCommitDistance")(function* (
    cwd: string,
    fromCommitId: string,
    toCommitId: string,
  ) {
    if (!/^[0-9a-f]{40,64}$/u.test(fromCommitId) || !/^[0-9a-f]{40,64}$/u.test(toCommitId)) {
      return 0;
    }
    const result = yield* runJj(
      "JjVcsDriver.readCommitDistance",
      cwd,
      ["log", "--no-graph", "-r", `${fromCommitId}..${toCommitId}`, "-T", '"x\\n"'],
      { timeoutMs: 10_000, maxOutputBytes: 512 * 1024, ignoreWorkingCopy: true },
    );
    return result.stdout.split("\n").filter((line) => line === "x").length;
  });

  const trackingState = (
    bookmark: RawJjBookmark,
    relatedRemotes: ReadonlyArray<RawJjBookmark>,
  ): NonNullable<VcsListRefsResult["refs"][number]["tracking"]> => {
    if (bookmark.target.length !== 1) {
      return {
        state: "conflicted",
        remoteName: bookmark.remote ?? null,
        aheadCount: 0,
        behindCount: 0,
      };
    }
    if (bookmark.remote !== undefined) {
      if (bookmark.tracking_target === undefined) {
        return { state: "untracked", remoteName: bookmark.remote, aheadCount: 0, behindCount: 0 };
      }
      return {
        state:
          bookmark.tracking_target.length === 1 &&
          bookmark.tracking_target[0] === bookmark.target[0]
            ? "synced"
            : "divergent",
        remoteName: bookmark.remote,
        aheadCount: 0,
        behindCount: 0,
      };
    }
    const trackedRemotes = relatedRemotes.filter(
      (remote) => remote.tracking_target !== undefined && remote.tracking_target.length > 0,
    );
    if (trackedRemotes.length === 0) {
      return { state: "untracked", remoteName: null, aheadCount: 0, behindCount: 0 };
    }
    const conflicted = trackedRemotes.some((remote) => remote.target.length !== 1);
    const synced = trackedRemotes.every(
      (remote) => remote.target.length === 1 && remote.target[0] === bookmark.target[0],
    );
    return {
      state: conflicted ? "conflicted" : synced ? "synced" : "divergent",
      remoteName: trackedRemotes[0]?.remote ?? null,
      aheadCount: 0,
      behindCount: 0,
    };
  };

  const listRefs: NonNullable<VcsDriver.VcsDriver["Service"]["listRefs"]> = Effect.fn(
    "JjVcsDriver.listRefs",
  )(function* (input) {
    const [bookmarks, workingCopy, trunkCommitId] = yield* Effect.all(
      [
        readBookmarks(input.cwd),
        readWorkingCopyCommit(input.cwd),
        readRevisionCommitId(input.cwd, "trunk()"),
      ],
      { concurrency: "unbounded" },
    );
    const remoteByName = new Map<string, RawJjBookmark[]>();
    for (const bookmark of bookmarks) {
      if (bookmark.remote === undefined) continue;
      const related = remoteByName.get(bookmark.name) ?? [];
      related.push(bookmark);
      remoteByName.set(bookmark.name, related);
    }

    const query = input.query?.trim().toLowerCase() ?? "";
    const requestedKind = input.refKind ?? "all";
    const includeRemote = requestedKind !== "local";
    const includeLocal = requestedKind !== "remote";
    const selectedBookmarks = bookmarks
      .filter((bookmark) => (bookmark.remote === undefined ? includeLocal : includeRemote))
      .filter((bookmark) => query.length === 0 || bookmark.name.toLowerCase().includes(query));
    const allRefs = yield* Effect.forEach(
      selectedBookmarks,
      Effect.fn("JjVcsDriver.listRefs.mapBookmark")(function* (bookmark) {
        const targetCommitId = bookmark.target.length === 1 ? (bookmark.target[0] ?? null) : null;
        let tracking = trackingState(bookmark, remoteByName.get(bookmark.name) ?? []);
        const trackingPeer =
          bookmark.remote === undefined
            ? (remoteByName.get(bookmark.name) ?? []).find(
                (remote) =>
                  remote.remote !== "git" &&
                  remote.target.length === 1 &&
                  remote.tracking_target?.length === 1,
              )
            : bookmark.target.length === 1 && bookmark.tracking_target?.length === 1
              ? bookmark
              : undefined;
        const peerCommitId = trackingPeer?.target[0];
        const localCommitId =
          bookmark.remote === undefined ? targetCommitId : trackingPeer?.tracking_target?.[0];
        if (peerCommitId && localCommitId) {
          const [aheadCount, behindCount] = yield* Effect.all(
            [
              readCommitDistance(input.cwd, peerCommitId, localCommitId),
              readCommitDistance(input.cwd, localCommitId, peerCommitId),
            ],
            { concurrency: "unbounded" },
          );
          tracking = {
            ...tracking,
            state:
              aheadCount > 0 && behindCount > 0
                ? "divergent"
                : aheadCount > 0
                  ? "ahead"
                  : behindCount > 0
                    ? "behind"
                    : "synced",
            aheadCount,
            behindCount,
          };
        }
        return {
          name: bookmark.name,
          kind: "bookmark" as const,
          ...(bookmark.remote === undefined
            ? { isRemote: false }
            : { isRemote: true, remoteName: bookmark.remote }),
          current: bookmark.remote === undefined && targetCommitId === workingCopy.commitId,
          isDefault: targetCommitId !== null && targetCommitId === trunkCommitId,
          worktreePath:
            bookmark.remote === undefined && targetCommitId === workingCopy.commitId
              ? input.cwd
              : null,
          targetChangeId: targetCommitId === workingCopy.commitId ? workingCopy.changeId : null,
          targetCommitId,
          tracking,
        };
      }),
      { concurrency: 8 },
    );
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? 100;
    const refs = allRefs.slice(cursor, cursor + limit);
    const nextCursor = cursor + refs.length < allRefs.length ? cursor + refs.length : null;
    const remotes = yield* listRemotes(input.cwd);
    return {
      refs,
      isRepo: true,
      hasPrimaryRemote: remotes.remotes.some((remote) => remote.isPrimary),
      nextCursor,
      totalCount: allRefs.length,
    };
  });

  const status: NonNullable<VcsDriver.VcsDriver["Service"]["status"]> = Effect.fn(
    "JjVcsDriver.status",
  )(function* (input) {
    const [workingCopy, diffEntries, refs, remotes, workspaces, juzuProbe, rootPath] =
      yield* Effect.all(
        [
          readWorkingCopyCommit(input.cwd),
          readDiffEntries(input.cwd),
          listRefs({ cwd: input.cwd, limit: 200 }),
          listRemotes(input.cwd),
          readWorkspaces(input.cwd),
          process
            .run({
              operation: "JjVcsDriver.status.juzu",
              command: "juzu",
              args: ["--version"],
              cwd: input.cwd,
              allowNonZeroExit: true,
              timeoutMs: 5_000,
              maxOutputBytes: 8_192,
            })
            .pipe(Effect.orElseSucceed(() => null)),
          runJj("JjVcsDriver.status.root", input.cwd, ["root"], {
            timeoutMs: 5_000,
            maxOutputBytes: 8_192,
            ignoreWorkingCopy: true,
          }).pipe(Effect.map((result) => result.stdout.trim())),
        ],
        { concurrency: "unbounded" },
      );
    const localBookmarks = refs.refs.filter(
      (ref) => ref.isRemote !== true && ref.targetCommitId === workingCopy.commitId,
    );
    const currentBookmark = localBookmarks[0] ?? null;
    const primaryRemote = remotes.remotes.find((remote) => remote.isPrimary) ?? null;
    const sourceControlProvider = primaryRemote
      ? detectSourceControlProviderFromRemoteUrl(primaryRemote.url)
      : null;
    const conflictPaths = [
      ...new Set([
        ...workingCopy.conflictPaths,
        ...diffEntries.filter((entry) => entry.conflict).map((entry) => entry.path),
      ]),
    ];
    const matchingWorkspaces = workspaces.filter(
      (workspace) => workspace.target.commit_id === workingCopy.commitId,
    );
    const workspaceName =
      matchingWorkspaces.length === 1
        ? (matchingWorkspaces[0]?.name ?? path.basename(rootPath))
        : path.basename(rootPath);
    const capabilities = {
      ...staticCapabilities,
      supportsJuzu: juzuProbe !== null && juzuProbe.exitCode === 0,
      supportsChangeRequests:
        sourceControlProvider !== null && sourceControlProvider.kind !== "unknown",
    };
    return {
      kind: "jj",
      capabilities,
      isRepo: true,
      ...(sourceControlProvider ? { sourceControlProvider } : {}),
      hasPrimaryRemote: primaryRemote !== null,
      isDefaultRef: currentBookmark?.isDefault ?? false,
      refName: currentBookmark?.name ?? null,
      hasWorkingTreeChanges: !workingCopy.empty,
      workingTree: {
        files: diffEntries.map((entry) => ({ path: entry.path, insertions: 0, deletions: 0 })),
        insertions: 0,
        deletions: 0,
      },
      workingCopy: {
        changeId: workingCopy.changeId,
        commitId: workingCopy.commitId,
        description: workingCopy.description,
        workspaceName,
        isEmpty: workingCopy.empty,
        hasConflicts: workingCopy.conflict || conflictPaths.length > 0,
        conflictPaths,
        bookmarks: localBookmarks.map((bookmark) => bookmark.name),
      },
      hasUpstream: currentBookmark?.tracking?.state !== "untracked" && currentBookmark !== null,
      aheadCount: currentBookmark?.tracking?.aheadCount ?? 0,
      behindCount: currentBookmark?.tracking?.behindCount ?? 0,
      aheadOfDefaultCount: 0,
      pr: null,
    } satisfies VcsStatusResult;
  });

  const createRef: NonNullable<VcsDriver.VcsDriver["Service"]["createRef"]> = Effect.fn(
    "JjVcsDriver.createRef",
  )(function* (input) {
    yield* runJj("JjVcsDriver.createRef", input.cwd, [
      "bookmark",
      "set",
      "--allow-backwards",
      input.refName,
      "-r",
      "@",
    ]);
    return { refName: input.refName } satisfies VcsCreateRefResult;
  });

  const switchRef: NonNullable<VcsDriver.VcsDriver["Service"]["switchRef"]> = Effect.fn(
    "JjVcsDriver.switchRef",
  )(function* (input) {
    yield* runJj("JjVcsDriver.switchRef", input.cwd, ["edit", input.refName]);
    return { refName: input.refName } satisfies VcsSwitchRefResult;
  });

  const describeChange: NonNullable<VcsDriver.VcsDriver["Service"]["describeChange"]> = Effect.fn(
    "JjVcsDriver.describeChange",
  )(function* (input) {
    yield* runJj("JjVcsDriver.describeChange", input.cwd, [
      "describe",
      "-r",
      "@",
      "-m",
      input.description,
    ]);
    const commit = yield* readWorkingCopyCommit(input.cwd);
    return {
      changeId: commit.changeId,
      commitId: commit.commitId,
      description: commit.description.trim(),
    } satisfies VcsDescribeChangeResult;
  });

  const startChange: NonNullable<VcsDriver.VcsDriver["Service"]["startChange"]> = Effect.fn(
    "JjVcsDriver.startChange",
  )(function* (input) {
    yield* runJj("JjVcsDriver.startChange", input.cwd, ["new", input.parentRevision ?? "@"]);
    const commit = yield* readWorkingCopyCommit(input.cwd);
    return { changeId: commit.changeId, commitId: commit.commitId } satisfies VcsStartChangeResult;
  });

  const fetch: NonNullable<VcsDriver.VcsDriver["Service"]["fetch"]> = Effect.fn(
    "JjVcsDriver.fetch",
  )(function* (input) {
    yield* runJj("JjVcsDriver.fetch", input.cwd, [
      "git",
      "fetch",
      ...(input.remoteName ? ["--remote", input.remoteName] : []),
    ]);
    return { status: "fetched", remoteName: input.remoteName ?? null } satisfies VcsFetchResult;
  });

  const pushBookmark: NonNullable<VcsDriver.VcsDriver["Service"]["pushBookmark"]> = Effect.fn(
    "JjVcsDriver.pushBookmark",
  )(function* (input) {
    const workingCopy = yield* readWorkingCopyCommit(input.cwd);
    if (workingCopy.conflict) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail: "Resolve working-copy conflicts before pushing a bookmark.",
      });
    }
    if (workingCopy.description.trim().length === 0) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail: "Describe the current change before pushing it.",
      });
    }
    const bookmarks = yield* readBookmarks(input.cwd);
    const bookmark = bookmarks.find(
      (candidate) => candidate.remote === undefined && candidate.name === input.bookmarkName,
    );
    if (!bookmark) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail: `Create bookmark '${input.bookmarkName}' before pushing.`,
      });
    }
    if (bookmark.target.length !== 1) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail: `Resolve the conflicted bookmark '${input.bookmarkName}' before pushing.`,
      });
    }
    const localRef = (yield* listRefs({
      cwd: input.cwd,
      query: input.bookmarkName,
      refKind: "local",
      limit: 20,
    })).refs.find((ref) => ref.name === input.bookmarkName);
    if (
      localRef?.tracking?.state === "behind" ||
      localRef?.tracking?.state === "divergent" ||
      localRef?.tracking?.state === "conflicted"
    ) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail: `Bookmark '${input.bookmarkName}' is ${localRef.tracking.state} relative to its tracked remote. Fetch and reconcile it before pushing.`,
      });
    }
    yield* runJj("JjVcsDriver.pushBookmark", input.cwd, [
      "git",
      "push",
      ...(input.remoteName ? ["--remote", input.remoteName] : []),
      "--bookmark",
      `exact:${input.bookmarkName}`,
    ]);
    return {
      status: "pushed",
      bookmarkName: input.bookmarkName,
      remoteName: input.remoteName ?? null,
    } satisfies VcsPushBookmarkResult;
  });

  const createWorktree: NonNullable<VcsDriver.VcsDriver["Service"]["createWorktree"]> = Effect.fn(
    "JjVcsDriver.createWorktree",
  )(function* (input) {
    const repository = yield* detectRepository(input.cwd);
    if (!repository) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.createWorktree",
        kind: "jj",
        detail: "No Jujutsu repository was detected.",
      });
    }
    const semanticName = input.newRefName ?? input.refName;
    const workspaceName = sanitizeWorkspaceName(semanticName);
    const workspacePath =
      input.path ??
      path.join(
        repository.rootPath,
        ".shuv2code",
        "workspaces",
        path.basename(repository.rootPath),
        workspaceName,
      );
    if (
      yield* fileSystem
        .exists(workspacePath)
        .pipe(mapFileSystemError("JjVcsDriver.createWorktree", "Could not inspect workspace path"))
    ) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.createWorktree",
        kind: "jj",
        detail: `Workspace path already exists: ${workspacePath}`,
      });
    }
    if (input.newRefName) {
      yield* runJj("JjVcsDriver.createWorktree.bookmark", input.cwd, [
        "bookmark",
        "set",
        input.newRefName,
        "-r",
        input.baseRefName ?? input.refName,
      ]);
    }
    yield* runJj("JjVcsDriver.createWorktree", input.cwd, [
      "workspace",
      "add",
      "--name",
      workspaceName,
      "-r",
      input.newRefName ?? input.refName,
      workspacePath,
    ]);
    if (input.newRefName) {
      yield* runJj("JjVcsDriver.createWorktree.moveBookmark", workspacePath, [
        "bookmark",
        "set",
        input.newRefName,
        "-r",
        "@",
      ]);
    }
    return {
      worktree: { path: workspacePath, refName: semanticName },
    } satisfies VcsCreateWorktreeResult;
  });

  const resolveRepoStoragePath = Effect.fn("JjVcsDriver.resolveRepoStoragePath")(function* (
    root: string,
  ) {
    const repoEntry = path.join(root, ".jj", "repo");
    const pointer = yield* fileSystem
      .readFileString(repoEntry)
      .pipe(Effect.orElseSucceed(() => ""));
    return yield* fileSystem
      .realPath(
        pointer.trim().length > 0
          ? path.resolve(path.dirname(repoEntry), pointer.trim())
          : repoEntry,
      )
      .pipe(
        mapFileSystemError(
          "JjVcsDriver.resolveRepoStoragePath",
          "Could not resolve Jujutsu repository storage",
        ),
      );
  });

  const removeWorktree: NonNullable<VcsDriver.VcsDriver["Service"]["removeWorktree"]> = Effect.fn(
    "JjVcsDriver.removeWorktree",
  )(function* (input) {
    const [sourceRootResult, targetRootResult] = yield* Effect.all([
      runJj("JjVcsDriver.removeWorktree.sourceRoot", input.cwd, ["root"], {
        ignoreWorkingCopy: true,
      }),
      runJj("JjVcsDriver.removeWorktree.targetRoot", input.path, ["root"], {
        ignoreWorkingCopy: true,
      }),
    ]);
    const [sourceRoot, targetRoot, requestedTarget] = yield* Effect.all(
      [
        fileSystem.realPath(sourceRootResult.stdout.trim()),
        fileSystem.realPath(targetRootResult.stdout.trim()),
        fileSystem.realPath(input.path),
      ],
      { concurrency: "unbounded" },
    ).pipe(mapFileSystemError("JjVcsDriver.removeWorktree", "Could not resolve workspace paths"));
    if (targetRoot !== requestedTarget || sourceRoot === targetRoot) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.removeWorktree",
        kind: "jj",
        detail: "Refusing to remove an unverified or current workspace path.",
      });
    }
    const [sourceRepo, targetRepo] = yield* Effect.all([
      resolveRepoStoragePath(sourceRoot),
      resolveRepoStoragePath(targetRoot),
    ]);
    if (sourceRepo !== targetRepo) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.removeWorktree",
        kind: "jj",
        detail: "Refusing to forget a workspace belonging to another repository.",
      });
    }
    const targetCommit = yield* readWorkingCopyCommit(targetRoot);
    if (!targetCommit.empty && input.force !== true) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.removeWorktree",
        kind: "jj",
        detail: "The workspace has local changes; confirm forced removal to forget it.",
      });
    }
    const matchingWorkspaces = (yield* readWorkspaces(input.cwd)).filter(
      (workspace) => workspace.target.commit_id === targetCommit.commitId,
    );
    if (matchingWorkspaces.length !== 1) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.removeWorktree",
        kind: "jj",
        detail: "Could not identify exactly one workspace for the verified path.",
      });
    }
    const workspace = matchingWorkspaces[0];
    if (!workspace) return;
    yield* runJj("JjVcsDriver.removeWorktree.forget", input.cwd, [
      "workspace",
      "forget",
      workspace.name,
    ]);
    yield* fileSystem
      .remove(targetRoot, { recursive: true })
      .pipe(
        mapFileSystemError("JjVcsDriver.removeWorktree", "Could not remove forgotten workspace"),
      );
  });

  const resolveRevision = (cwd: string, revision: string) =>
    runJj(
      "JjVcsDriver.checkpoints.resolveRevision",
      cwd,
      ["log", "--no-graph", "-r", revision, "-T", 'commit_id ++ "\\n"'],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 8_192,
        ignoreWorkingCopy: true,
      },
    ).pipe(
      Effect.map((result) =>
        result.exitCode === 0 && result.stdout.trim().length > 0 ? revision : null,
      ),
    );

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: (input) =>
      runJj(
        "JjVcsDriver.checkpoints.captureCheckpoint",
        input.cwd,
        ["tag", "set", "--allow-move", input.checkpointRef, "-r", "@"],
        { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
      ).pipe(Effect.asVoid),
    hasCheckpointRef: (input) =>
      resolveRevision(input.cwd, input.checkpointRef).pipe(
        Effect.map((revision) => revision !== null),
      ),
    restoreCheckpoint: Effect.fn("JjVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const checkpoint = yield* resolveRevision(input.cwd, input.checkpointRef);
      const source = checkpoint ?? (input.fallbackToHead ? "@-" : null);
      if (!source) return false;
      yield* runJj("JjVcsDriver.checkpoints.restoreCheckpoint.newChange", input.cwd, ["new", "@"], {
        timeoutMs: 30_000,
        maxOutputBytes: 1_000_000,
      });
      yield* runJj(
        "JjVcsDriver.checkpoints.restoreCheckpoint",
        input.cwd,
        ["restore", "--from", source, "--into", "@"],
        { timeoutMs: 30_000, maxOutputBytes: 1_000_000 },
      );
      return true;
    }),
    diffCheckpoints: Effect.fn("JjVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const from = yield* resolveRevision(input.cwd, input.fromCheckpointRef);
      const fromRevision = from ?? (input.fallbackFromToHead ? "@-" : input.fromCheckpointRef);
      const result = yield* runJj(
        "JjVcsDriver.checkpoints.diffCheckpoints",
        input.cwd,
        [
          "diff",
          "--git",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          "--from",
          fromRevision,
          "--to",
          input.toCheckpointRef,
        ],
        {
          timeoutMs: 30_000,
          maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
          ignoreWorkingCopy: true,
        },
      );
      return result.stdout;
    }),
    deleteCheckpointRefs: (input) =>
      input.checkpointRefs.length === 0
        ? Effect.void
        : runJj(
            "JjVcsDriver.checkpoints.deleteCheckpointRefs",
            input.cwd,
            ["tag", "delete", ...input.checkpointRefs],
            { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
          ).pipe(Effect.asVoid),
  };

  const getDiffPreview = Effect.fn("JjVcsDriver.getDiffPreview")(function* (
    input: ReviewDiffPreviewInput,
  ): Effect.fn.Return<ReviewDiffPreviewResult, VcsError> {
    const workingResult = yield* runJj(
      "JjVcsDriver.getDiffPreview.workingCopy",
      input.cwd,
      ["diff", "--git", ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []), "-r", "@"],
      {
        maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );

    const requestedBaseRef = input.baseRef ?? "trunk()";
    const baseResult = yield* runJj(
      "JjVcsDriver.getDiffPreview.base",
      input.cwd,
      [
        "diff",
        "--git",
        ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
        "--from",
        requestedBaseRef,
        "--to",
        "@",
      ],
      {
        allowNonZeroExit: true,
        maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
        ignoreWorkingCopy: true,
      },
    );
    const hasBase = baseResult.exitCode === 0;
    const baseRef = hasBase ? requestedBaseRef : null;
    const baseDiff = hasBase ? baseResult.stdout : "";

    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources: [
        {
          id: "working-tree",
          kind: "working-tree",
          title: "Working-copy change (@)",
          baseRef: "@-",
          headRef: "@",
          diff: workingResult.stdout,
          diffHash: diffHash(workingResult.stdout),
          truncated: workingResult.stdoutTruncated,
        },
        {
          id: "branch-range",
          kind: "branch-range",
          title: baseRef ? `Against ${baseRef}` : "Against trunk",
          baseRef,
          headRef: "@",
          diff: baseDiff,
          diffHash: diffHash(baseDiff),
          truncated: hasBase ? baseResult.stdoutTruncated : false,
        },
      ],
    };
  });

  return VcsDriver.VcsDriver.of({
    capabilities: staticCapabilities,
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
    status,
    listRefs,
    createWorktree,
    removeWorktree,
    createRef,
    switchRef,
    describeChange,
    startChange,
    fetch,
    pushBookmark,
    getDiffPreview,
  });
});

export const layer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
