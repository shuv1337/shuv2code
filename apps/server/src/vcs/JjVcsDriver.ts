import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  VcsProcessExitError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type VcsError,
} from "@shuv2code/contracts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;

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
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;

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
    capabilities: {
      kind: "jj",
      supportsWorktrees: true,
      supportsBookmarks: true,
      supportsAtomicSnapshot: true,
      supportsPushDefaultRemote: true,
      ignoreClassifier: "git-compatible-fallback",
    },
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
    getDiffPreview,
  });
});

export const layer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
