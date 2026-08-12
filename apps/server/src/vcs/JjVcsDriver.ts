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
const SafeJjOperand = Schema.String.check(
  Schema.makeFilter((value) => !value.startsWith("-") || "must not start with '-'"),
);
const decodeSafeJjOperand = Schema.decodeUnknownEffect(SafeJjOperand);

const JJ_COMMIT_TEMPLATE =
  '"{" ++ "\\"commitId\\":" ++ json(commit_id) ++ ",\\"changeId\\":" ++ json(change_id) ++ ",\\"description\\":" ++ json(description) ++ ",\\"empty\\":" ++ json(empty) ++ ",\\"conflict\\":" ++ json(conflict) ++ ",\\"conflictPaths\\":" ++ json(conflicted_files.map(|entry| entry.path())) ++ "}\\n"';
const JJ_DIFF_ENTRY_TEMPLATE =
  '"{" ++ "\\"path\\":" ++ json(path) ++ ",\\"status\\":" ++ json(status) ++ ",\\"conflict\\":" ++ json(target.conflict()) ++ "}\\n"';

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

function parseJjRemoteLine(
  line: string,
): { readonly name: string; readonly url: string; readonly pushUrl: string | null } | null {
  const trimmed = line.trim();
  const separator = trimmed.search(/\s/u);
  if (separator <= 0) return null;

  const name = trimmed.slice(0, separator);
  let url = trimmed.slice(separator).trim();
  let pushUrl: string | null = null;
  const pushMarker = " (push: ";
  const pushMarkerIndex = url.lastIndexOf(pushMarker);
  if (pushMarkerIndex >= 0 && url.endsWith(")")) {
    pushUrl = url.slice(pushMarkerIndex + pushMarker.length, -1).trim() || null;
    url = url.slice(0, pushMarkerIndex).trim();
  }
  return name.length > 0 && url.length > 0 ? { name, url, pushUrl } : null;
}

export const makeVcsDriver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;

  const staticCapabilities = {
    kind: "jj" as const,
    supportsWorktrees: false,
    supportsBookmarks: true,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: false,
    supportsStatus: true,
    supportsRefMutation: true,
    supportsWorkspaceMutation: false,
    supportsDescribeChange: true,
    supportsStartChange: true,
    supportsFetch: true,
    supportsPush: true,
    supportsChangeRequests: true,
    supportsJuzu: false,
    ignoreClassifier: "git-compatible-fallback" as const,
  };

  const resolveNearestJjRoot = Effect.fn("JjVcsDriver.resolveNearestJjRoot")(function* (
    cwd: string,
  ) {
    const canonicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => null));
    if (!canonicalCwd) return null;
    const cwdType = yield* fileSystem.stat(canonicalCwd).pipe(
      Effect.map((info) => info.type),
      Effect.orElseSucceed(() => null),
    );
    if (cwdType !== "Directory") return null;

    let candidate = canonicalCwd;
    while (true) {
      const markerState = yield* fileSystem.stat(path.join(candidate, ".jj")).pipe(
        Effect.match({
          onFailure: (error) =>
            error.reason._tag === "NotFound" ? ("missing" as const) : ("invalid" as const),
          onSuccess: (info) =>
            info.type === "Directory" ? ("valid" as const) : ("invalid" as const),
        }),
      );
      if (markerState === "valid") {
        const layoutIsValid = yield* Effect.all([
          fileSystem.stat(path.join(candidate, ".jj", "repo")),
          fileSystem.stat(path.join(candidate, ".jj", "working_copy")),
        ]).pipe(
          Effect.match({
            onFailure: () => false,
            onSuccess: ([repoInfo, workingCopyInfo]) =>
              (repoInfo.type === "File" || repoInfo.type === "Directory") &&
              workingCopyInfo.type === "Directory",
          }),
        );
        return layoutIsValid ? candidate : null;
      }
      if (markerState === "invalid") return null;
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  });

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
    Effect.gen(function* () {
      const repositoryRoot = (yield* resolveNearestJjRoot(cwd)) ?? cwd;
      return yield* process.run({
        operation,
        command: "jj",
        args: [
          "--no-pager",
          "--color",
          "never",
          ...(options?.ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
          "-R",
          repositoryRoot,
          ...args,
        ],
        cwd,
        spawnCwd: globalThis.process.cwd(),
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options?.allowNonZeroExit !== undefined
          ? { allowNonZeroExit: options.allowNonZeroExit }
          : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.maxOutputBytes !== undefined
          ? { maxOutputBytes: options.maxOutputBytes }
          : {}),
        ...(options?.appendTruncationMarker !== undefined
          ? { appendTruncationMarker: options.appendTruncationMarker }
          : {}),
      });
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
    // Repository discovery is the one command that must run from the requested
    // directory so jj can perform its native ancestor search. All later
    // commands use the validated root returned below.
    const result = yield* process.run({
      operation: "JjVcsDriver.detectRepository",
      command: "jj",
      args: ["--no-pager", "--color", "never", "--ignore-working-copy", "root"],
      cwd,
      spawnCwd: cwd,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 8_192,
    });
    const reportedRoot = result.stdout.trim();
    if (result.exitCode !== 0 || result.stdoutTruncated || reportedRoot.length === 0) return null;

    const candidate = yield* resolveNearestJjRoot(cwd);
    const canonicalRoot = yield* fileSystem
      .realPath(reportedRoot)
      .pipe(Effect.orElseSucceed(() => null));
    if (candidate !== null && canonicalRoot !== candidate) return null;
    if (candidate === null) {
      const requestedPathExists = yield* fileSystem.realPath(cwd).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      );
      // Process-backed registry tests intentionally use virtual paths. In a
      // real invocation a missing spawn cwd cannot execute jj, so accepting an
      // absolute root here does not weaken live filesystem boundary checks.
      if (requestedPathExists || canonicalRoot !== null || !path.isAbsolute(reportedRoot)) {
        return null;
      }
    }
    const rootPath = canonicalRoot ?? path.normalize(reportedRoot);
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
    if (result.stdoutTruncated || result.stderrTruncated) {
      return yield* new VcsProcessExitError({
        operation: "JjVcsDriver.listRemotes",
        command: "jj git remote list",
        cwd,
        exitCode: 1,
        detail: "Jujutsu returned truncated remote metadata.",
      });
    }
    const parsed = result.stdout.split("\n").flatMap((line) => {
      const remote = parseJjRemoteLine(line);
      return remote ? [remote] : [];
    });
    const primaryName = parsed.some((remote) => remote.name === "origin")
      ? "origin"
      : parsed.length === 1
        ? (parsed[0]?.name ?? null)
        : null;
    return {
      remotes: parsed.map((remote) => ({
        name: remote.name,
        url: remote.url,
        pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none<string>(),
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
        args: ["--no-pager", "--color", "never", "git", "init", "--colocate", "--", input.cwd],
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

  const requireSafeJjOperand = Effect.fn("JjVcsDriver.requireSafeJjOperand")(function* (
    operation: string,
    label: string,
    value: string,
  ) {
    return yield* decodeSafeJjOperand(value).pipe(
      Effect.mapError(
        () =>
          new VcsUnsupportedOperationError({
            operation,
            kind: "jj",
            detail: `${label} must not start with '-'.`,
          }),
      ),
    );
  });

  // A bookmark name is a literal at the API boundary, but commands such as
  // `jj log -r` parse their argument as a revset. JSON string syntax is valid
  // revset quoting and prevents names like `root()` from becoming functions.
  const literalBookmarkRevision = (bookmarkName: string): string => JSON.stringify(bookmarkName);

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
    if (result.stdoutTruncated || result.stderrTruncated) {
      return yield* new VcsProcessExitError({
        operation,
        command: "jj bookmark list",
        cwd,
        exitCode: 1,
        detail: "Jujutsu bookmark output was truncated; refusing to use an incomplete ref set.",
      });
    }
    return yield* Effect.forEach(
      result.stdout.split("\n").filter((line) => line.trim().length > 0),
      (line) =>
        decodeRawJjBookmark(line).pipe(
          Effect.mapError(() => structuredOutputError(operation, cwd)),
        ),
    );
  });

  const readDefaultLocalBookmarkName = Effect.fn("JjVcsDriver.readDefaultLocalBookmarkName")(
    function* (cwd: string, bookmarks: ReadonlyArray<RawJjBookmark>) {
      const result = yield* runJj(
        "JjVcsDriver.readDefaultLocalBookmarkName",
        cwd,
        ["log", "--no-graph", "-r", "trunk()", "-T", 'commit_id ++ "\\n"'],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 8_192,
          ignoreWorkingCopy: true,
        },
      );
      if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) return null;
      const trunkCommitIds = new Set(
        result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /^[0-9a-f]{40,64}$/u.test(line)),
      );
      if (trunkCommitIds.size !== 1) return null;
      const defaultRemoteNames = bookmarks
        .filter(
          (bookmark) =>
            bookmark.remote !== undefined &&
            bookmark.remote !== "git" &&
            bookmark.target.length === 1 &&
            trunkCommitIds.has(bookmark.target[0] ?? ""),
        )
        .map((bookmark) => bookmark.name)
        .toSorted((left, right) => left.localeCompare(right));
      const remoteBackedLocal = defaultRemoteNames.find((name) =>
        bookmarks.some((bookmark) => bookmark.remote === undefined && bookmark.name === name),
      );
      if (remoteBackedLocal) return remoteBackedLocal;

      const localAtTrunk = bookmarks
        .filter(
          (bookmark) =>
            bookmark.remote === undefined &&
            bookmark.target.length === 1 &&
            trunkCommitIds.has(bookmark.target[0] ?? ""),
        )
        .toSorted((left, right) => left.name.localeCompare(right.name))[0];
      return localAtTrunk?.name ?? null;
    },
  );

  const readWorkspaces = Effect.fn("JjVcsDriver.readWorkspaces")(function* (cwd: string) {
    const operation = "JjVcsDriver.readWorkspaces";
    const result = yield* runJj(
      operation,
      cwd,
      ["workspace", "list", "-T", 'json(self) ++ "\\n"'],
      { timeoutMs: 10_000, maxOutputBytes: 512 * 1024, ignoreWorkingCopy: true },
    );
    if (result.stdoutTruncated || result.stderrTruncated) {
      return yield* new VcsProcessExitError({
        operation,
        command: "jj workspace list",
        cwd,
        exitCode: 1,
        detail: "Jujutsu returned truncated workspace metadata.",
      });
    }
    return yield* Effect.forEach(
      result.stdout.split("\n").filter((line) => line.trim().length > 0),
      (line) =>
        decodeRawJjWorkspace(line).pipe(
          Effect.mapError(() => structuredOutputError(operation, cwd)),
        ),
    );
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
      (remote) =>
        remote.remote !== "git" &&
        remote.tracking_target !== undefined &&
        remote.tracking_target.length > 0,
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

  const bookmarkRefName = (bookmark: RawJjBookmark): string =>
    bookmark.remote === undefined ? bookmark.name : `${bookmark.name}@${bookmark.remote}`;

  const mapBookmarkToRef = Effect.fn("JjVcsDriver.mapBookmarkToRef")(function* (
    cwd: string,
    bookmark: RawJjBookmark,
    relatedRemotes: ReadonlyArray<RawJjBookmark>,
    workingCopy: RawJjCommit,
    defaultBookmarkName: string | null,
  ) {
    const targetCommitId = bookmark.target.length === 1 ? (bookmark.target[0] ?? null) : null;
    let tracking = trackingState(bookmark, relatedRemotes);
    const trackingPeer =
      bookmark.remote === undefined
        ? relatedRemotes.find(
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
          readCommitDistance(cwd, peerCommitId, localCommitId),
          readCommitDistance(cwd, localCommitId, peerCommitId),
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
      name: bookmarkRefName(bookmark),
      kind: "bookmark" as const,
      ...(bookmark.remote === undefined
        ? { isRemote: false }
        : { isRemote: true, remoteName: bookmark.remote }),
      current: bookmark.remote === undefined && targetCommitId === workingCopy.commitId,
      isDefault: bookmark.remote === undefined && bookmark.name === defaultBookmarkName,
      worktreePath:
        bookmark.remote === undefined && targetCommitId === workingCopy.commitId ? cwd : null,
      targetChangeId: targetCommitId === workingCopy.commitId ? workingCopy.changeId : null,
      targetCommitId,
      tracking,
    } satisfies VcsListRefsResult["refs"][number];
  });

  const listRefs: NonNullable<VcsDriver.VcsDriver["Service"]["listRefs"]> = Effect.fn(
    "JjVcsDriver.listRefs",
  )(function* (input) {
    const [bookmarks, workingCopy] = yield* Effect.all(
      [readBookmarks(input.cwd), readWorkingCopyCommit(input.cwd)],
      { concurrency: "unbounded" },
    );
    const userBookmarks = bookmarks.filter((bookmark) => bookmark.remote !== "git");
    const defaultBookmarkName = yield* readDefaultLocalBookmarkName(input.cwd, userBookmarks);
    const remoteByName = new Map<string, RawJjBookmark[]>();
    for (const bookmark of userBookmarks) {
      if (bookmark.remote === undefined) continue;
      const related = remoteByName.get(bookmark.name) ?? [];
      related.push(bookmark);
      remoteByName.set(bookmark.name, related);
    }

    const query = input.query?.trim().toLowerCase() ?? "";
    const requestedKind = input.refKind ?? "all";
    const includeRemote = requestedKind !== "local";
    const includeLocal = requestedKind !== "remote";
    const selectedBookmarks = userBookmarks
      .filter((bookmark) => (bookmark.remote === undefined ? includeLocal : includeRemote))
      .filter(
        (bookmark) => query.length === 0 || bookmarkRefName(bookmark).toLowerCase().includes(query),
      );
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? 100;
    const pageBookmarks = selectedBookmarks.slice(cursor, cursor + limit);
    const refs = yield* Effect.forEach(
      pageBookmarks,
      (bookmark) =>
        mapBookmarkToRef(
          input.cwd,
          bookmark,
          remoteByName.get(bookmark.name) ?? [],
          workingCopy,
          defaultBookmarkName,
        ),
      { concurrency: 8 },
    );
    const nextCursor =
      cursor + refs.length < selectedBookmarks.length ? cursor + refs.length : null;
    const remotes = yield* listRemotes(input.cwd);
    return {
      refs,
      isRepo: true,
      hasPrimaryRemote: remotes.remotes.some((remote) => remote.isPrimary),
      nextCursor,
      totalCount: selectedBookmarks.length,
    };
  });

  const status: NonNullable<VcsDriver.VcsDriver["Service"]["status"]> = Effect.fn(
    "JjVcsDriver.status",
  )(function* (input) {
    const [workingCopy, diffEntries, bookmarks, remotes, workspaces, juzuProbe, rootPath] =
      yield* Effect.all(
        [
          readWorkingCopyCommit(input.cwd),
          readDiffEntries(input.cwd),
          readBookmarks(input.cwd),
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
    const userBookmarks = bookmarks.filter((bookmark) => bookmark.remote !== "git");
    const defaultBookmarkName = yield* readDefaultLocalBookmarkName(input.cwd, userBookmarks);
    const remoteByName = new Map<string, RawJjBookmark[]>();
    for (const bookmark of userBookmarks) {
      if (bookmark.remote === undefined) continue;
      const related = remoteByName.get(bookmark.name) ?? [];
      related.push(bookmark);
      remoteByName.set(bookmark.name, related);
    }
    const currentBookmarkEntries = userBookmarks.filter(
      (bookmark) =>
        bookmark.remote === undefined &&
        bookmark.target.length === 1 &&
        bookmark.target[0] === workingCopy.commitId,
    );
    const selectedCurrentBookmark =
      currentBookmarkEntries.find((bookmark) => bookmark.name === defaultBookmarkName) ??
      currentBookmarkEntries[0] ??
      null;
    const currentBookmark = selectedCurrentBookmark
      ? yield* mapBookmarkToRef(
          input.cwd,
          selectedCurrentBookmark,
          remoteByName.get(selectedCurrentBookmark.name) ?? [],
          workingCopy,
          defaultBookmarkName,
        )
      : null;
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
        bookmarks: currentBookmarkEntries.map((bookmark) => bookmark.name),
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
    const refName = yield* requireSafeJjOperand(
      "JjVcsDriver.createRef",
      "Bookmark name",
      input.refName,
    );
    yield* runJj("JjVcsDriver.createRef", input.cwd, [
      "bookmark",
      "set",
      "--allow-backwards",
      literalBookmarkRevision(refName),
      "-r",
      "@",
    ]);
    return { refName } satisfies VcsCreateRefResult;
  });

  const switchRef: NonNullable<VcsDriver.VcsDriver["Service"]["switchRef"]> = Effect.fn(
    "JjVcsDriver.switchRef",
  )(function* (input) {
    const refName = yield* requireSafeJjOperand("JjVcsDriver.switchRef", "Revision", input.refName);
    const bookmarks = yield* readBookmarks(input.cwd);
    const matchingBookmarks = bookmarks.filter(
      (bookmark) => bookmarkRefName(bookmark) === refName && bookmark.remote !== "git",
    );
    if (matchingBookmarks.length > 1 || matchingBookmarks[0]?.target.length !== 1) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.switchRef",
        kind: "jj",
        detail: `Revision '${refName}' does not resolve to exactly one bookmark target.`,
      });
    }
    const revision = matchingBookmarks[0]?.target[0] ?? refName;
    const target = yield* readWorkingCopyCommit(input.cwd, revision);
    const mutableResult = yield* runJj(
      "JjVcsDriver.switchRef.mutable",
      input.cwd,
      ["log", "--no-graph", "-r", `${target.commitId} & mutable()`, "-T", 'commit_id ++ "\\n"'],
      { timeoutMs: 10_000, maxOutputBytes: 8_192, ignoreWorkingCopy: true },
    );
    const mutableTarget = mutableResult.stdout.trim() === target.commitId;
    yield* runJj("JjVcsDriver.switchRef", input.cwd, [
      mutableTarget ? "edit" : "new",
      target.commitId,
    ]);
    return { refName } satisfies VcsSwitchRefResult;
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
    const parentRevision = yield* requireSafeJjOperand(
      "JjVcsDriver.startChange",
      "Parent revision",
      input.parentRevision ?? "@",
    );
    const parent = yield* readWorkingCopyCommit(input.cwd, parentRevision);
    yield* runJj("JjVcsDriver.startChange", input.cwd, ["new", parent.commitId]);
    const commit = yield* readWorkingCopyCommit(input.cwd);
    return { changeId: commit.changeId, commitId: commit.commitId } satisfies VcsStartChangeResult;
  });

  const fetch: NonNullable<VcsDriver.VcsDriver["Service"]["fetch"]> = Effect.fn(
    "JjVcsDriver.fetch",
  )(function* (input) {
    const requestedRemoteName = input.remoteName
      ? yield* requireSafeJjOperand("JjVcsDriver.fetch", "Remote name", input.remoteName)
      : undefined;
    const remotes = yield* listRemotes(input.cwd);
    const remoteName =
      requestedRemoteName ?? remotes.remotes.find((remote) => remote.isPrimary)?.name;
    if (!remoteName) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.fetch",
        kind: "jj",
        detail:
          "Choose a remote explicitly when this repository has no unambiguous primary remote.",
      });
    }
    yield* runJj("JjVcsDriver.fetch", input.cwd, ["git", "fetch", "--remote", remoteName]);
    return { status: "fetched", remoteName } satisfies VcsFetchResult;
  });

  const pushBookmark: NonNullable<VcsDriver.VcsDriver["Service"]["pushBookmark"]> = Effect.fn(
    "JjVcsDriver.pushBookmark",
  )(function* (input) {
    const requestedRemoteName = input.remoteName
      ? yield* requireSafeJjOperand("JjVcsDriver.pushBookmark", "Remote name", input.remoteName)
      : undefined;
    const remotes = yield* listRemotes(input.cwd);
    const remoteName =
      requestedRemoteName ?? remotes.remotes.find((remote) => remote.isPrimary)?.name;
    if (!remoteName) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail:
          "Choose a remote explicitly when this repository has no unambiguous primary remote.",
      });
    }
    const [workingCopy, bookmarks] = yield* Effect.all(
      [readWorkingCopyCommit(input.cwd), readBookmarks(input.cwd)],
      { concurrency: "unbounded" },
    );
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
    const targetCommitId = bookmark.target[0];
    if (!targetCommitId || targetCommitId !== workingCopy.commitId) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail: `Bookmark '${input.bookmarkName}' must point at the current change before pushing.`,
      });
    }
    const bookmarkTarget = yield* readWorkingCopyCommit(input.cwd, targetCommitId);
    if (bookmarkTarget.conflict) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail: `Resolve conflicts in bookmark '${input.bookmarkName}' before pushing.`,
      });
    }
    if (bookmarkTarget.description.trim().length === 0) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail: `Describe bookmark '${input.bookmarkName}' before pushing it.`,
      });
    }
    const selectedRemoteBookmark = bookmarks.find(
      (candidate) => candidate.remote === remoteName && candidate.name === input.bookmarkName,
    );
    if (selectedRemoteBookmark && selectedRemoteBookmark.target.length !== 1) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail: `Resolve the conflicted '${input.bookmarkName}@${remoteName}' bookmark before pushing.`,
      });
    }
    const selectedRemoteTargetCommitId = selectedRemoteBookmark?.target[0] ?? null;
    if (selectedRemoteTargetCommitId) {
      const [aheadCount, behindCount] = yield* Effect.all(
        [
          readCommitDistance(input.cwd, selectedRemoteTargetCommitId, targetCommitId),
          readCommitDistance(input.cwd, targetCommitId, selectedRemoteTargetCommitId),
        ],
        { concurrency: "unbounded" },
      );
      if (behindCount > 0) {
        const state = aheadCount > 0 ? "divergent" : "behind";
        return yield* new VcsUnsupportedOperationError({
          operation: "JjVcsDriver.pushBookmark",
          kind: "jj",
          detail: `Bookmark '${input.bookmarkName}' is ${state} relative to '${remoteName}'. Fetch and reconcile it before pushing.`,
        });
      }
    }
    const latestBookmarks = yield* readBookmarks(input.cwd);
    const latestBookmark = latestBookmarks.find(
      (candidate) => candidate.remote === undefined && candidate.name === input.bookmarkName,
    );
    if (latestBookmark?.target.length !== 1 || latestBookmark.target[0] !== targetCommitId) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail: `Bookmark '${input.bookmarkName}' changed while preparing the push; retry it.`,
      });
    }
    const latestRemoteBookmark = latestBookmarks.find(
      (candidate) => candidate.remote === remoteName && candidate.name === input.bookmarkName,
    );
    if (
      (latestRemoteBookmark?.target.length === 1
        ? (latestRemoteBookmark.target[0] ?? null)
        : null) !== selectedRemoteTargetCommitId
    ) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.pushBookmark",
        kind: "jj",
        detail: `Remote bookmark '${input.bookmarkName}@${remoteName}' changed while preparing the push; retry it.`,
      });
    }
    yield* runJj("JjVcsDriver.pushBookmark", input.cwd, [
      "git",
      "push",
      "--remote",
      remoteName,
      "--bookmark",
      `exact:${input.bookmarkName}`,
    ]);
    return {
      status: "pushed",
      bookmarkName: input.bookmarkName,
      remoteName,
    } satisfies VcsPushBookmarkResult;
  });

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
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
    status,
    listRefs,
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
