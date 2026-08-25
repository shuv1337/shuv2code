/**
 * The JJ mechanics half of the ADE integration service (spec §4.4, ADR §6.2,
 * §6.3, §14.3, §14.4).
 *
 * The state machine in `AdeIntegrationService` owns *policy*: gates, reviewer
 * routing, bounces, repair assignments. This port owns *mechanics*: fetching
 * upstream, materializing an isolated JJ workspace per candidate, running the
 * project's check commands inside it, advancing the canonical bookmark, and
 * cleaning up. Splitting them is what lets the state-machine tests run against
 * a deterministic stub while one runtime test drives real `jj`.
 *
 * Every operation is written to be **re-runnable from scratch** rather than
 * resumable, because ADR §16.2 rejected a per-step journal:
 * `prepareCandidateWorkspace` forgets and deletes any workspace left by a
 * previous pass before creating its own, and canonical advancement is the
 * single durable commit point.
 *
 * `jj` invocations ride the existing `VcsDriver.execute` seam (JjVcsDriver
 * pins `-R <validated root>` and spawns from a stable cwd), so ADE gains no
 * second process-spawning path.
 */
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { JJ_CHANGE_ID_PATTERN } from "@shuv2code/contracts";
import { HostProcessPlatform } from "@shuv2code/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A mechanical failure that is *not* a candidate verdict: the repository could
 * not be operated at all. The service treats it as a transient pass failure and
 * leaves the candidate on the queue head, because re-running is free (ADR
 * §16.2) and inventing a bounce would fabricate feedback for the author.
 */
export class AdeIntegrationRepoError extends Schema.TaggedErrorClass<AdeIntegrationRepoError>()(
  "AdeIntegrationRepoError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ADE integration repository operation '${this.operation}' failed: ${this.detail}`;
  }
}

// ---------------------------------------------------------------------------
// Port shape
// ---------------------------------------------------------------------------

/** The bookmark naming a project's canonical integration head (ADR §6.3). */
export const ADE_CANONICAL_BOOKMARK = "main";

/** Per-check wall clock; a hung check must not wedge the project queue. */
export const ADE_CHECK_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Total budget across a project's whole check suite. Per-check timeouts alone
 * let twenty slow checks hold the queue for five hours; the aggregate budget is
 * what actually bounds a pass.
 */
export const ADE_CHECK_SUITE_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * `jj` invocations get explicit, generous deadlines rather than VcsProcess's
 * 30s default: `git fetch` and `workspace add` legitimately run for minutes on
 * a large repo, and a deferred pass that silently retries forever is worse than
 * a loud failure.
 */
export const ADE_JJ_NETWORK_TIMEOUT_MS = 10 * 60 * 1000;
export const ADE_JJ_LOCAL_TIMEOUT_MS = 5 * 60 * 1000;

export interface SyncUpstreamInput {
  readonly repoPath: string;
  readonly remote: string | null;
  readonly canonicalBookmark?: string;
}

export interface SyncUpstreamResult {
  /** True when upstream movement landed on canonical during this pass. */
  readonly advanced: boolean;
  /** Set when the canonical rebase conflicted — a bounce-worthy verdict. */
  readonly conflictDetail: string | null;
}

export interface PrepareCandidateWorkspaceInput {
  readonly repoPath: string;
  readonly workspacePath: string;
  readonly workspaceName: string;
  readonly changeIds: ReadonlyArray<string>;
  readonly canonicalBookmark?: string;
}

export interface PrepareCandidateWorkspaceResult {
  readonly workspacePath: string;
  /** The rebased head the gate will advance canonical to, once it is green. */
  readonly headRevision: string;
  /** Set when the rebase conflicted — a bounce-worthy verdict, not an error. */
  readonly conflictDetail: string | null;
}

export interface RunChecksInput {
  readonly workspacePath: string;
  readonly checkCommands: ReadonlyArray<string>;
}

export interface CheckFailure {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
}

export interface RunChecksResult {
  readonly passed: boolean;
  readonly failures: ReadonlyArray<CheckFailure>;
}

export interface AdvanceCanonicalInput {
  readonly repoPath: string;
  readonly headRevision: string;
  readonly canonicalBookmark?: string;
}

/**
 * Canonical advancement is fast-forward-only. `diverged` is the guard against
 * the data-loss shape this pipeline otherwise has: an upstream sync (or any
 * other advancement) can move canonical past a candidate that was rebased
 * before it, and resetting the bookmark to that stale head would drop the
 * commits in between. The caller re-runs the candidate instead.
 */
export type AdvanceCanonicalResult =
  | { readonly _tag: "advanced"; readonly canonicalCommitId: string }
  /** `headRevision` is already an ancestor of canonical — nothing to do. */
  | { readonly _tag: "already-integrated"; readonly canonicalCommitId: string }
  | { readonly _tag: "diverged"; readonly canonicalCommitId: string; readonly detail: string };

export interface CanonicalStateInput {
  readonly repoPath: string;
  readonly headRevision: string;
  readonly canonicalBookmark?: string;
}

export interface CanonicalStateResult {
  /** `headRevision` is an ancestor of, or equal to, canonical. */
  readonly containsHead: boolean;
  /** Canonical is an ancestor of, or equal to, `headRevision`. */
  readonly fastForwardable: boolean;
  readonly canonicalCommitId: string;
}

export interface CleanupWorkspaceInput {
  readonly repoPath: string;
  readonly workspacePath: string;
  readonly workspaceName: string;
}

export interface AdeIntegrationRepoPortShape {
  /** Explicit upstream sync (ADR §14.3): fetch, then rebase canonical onto it. */
  readonly syncUpstream: (
    input: SyncUpstreamInput,
  ) => Effect.Effect<SyncUpstreamResult, AdeIntegrationRepoError>;
  /** Materialize the candidate's isolated workspace, rebased onto canonical. */
  readonly prepareCandidateWorkspace: (
    input: PrepareCandidateWorkspaceInput,
  ) => Effect.Effect<PrepareCandidateWorkspaceResult, AdeIntegrationRepoError>;
  readonly runChecks: (
    input: RunChecksInput,
  ) => Effect.Effect<RunChecksResult, AdeIntegrationRepoError>;
  /**
   * Ancestry probe used to make the pipeline idempotent: a pass that died after
   * advancing canonical can re-derive that fact instead of re-rebasing a change
   * that is already landed (which reads as a conflict and bounces the author for
   * nothing).
   */
  readonly canonicalState: (
    input: CanonicalStateInput,
  ) => Effect.Effect<CanonicalStateResult, AdeIntegrationRepoError>;
  /** The single durable commit point of the whole pipeline (ADR §16.2). */
  readonly advanceCanonical: (
    input: AdvanceCanonicalInput,
  ) => Effect.Effect<AdvanceCanonicalResult, AdeIntegrationRepoError>;
  readonly cleanupWorkspace: (
    input: CleanupWorkspaceInput,
  ) => Effect.Effect<void, AdeIntegrationRepoError>;
}

export class AdeIntegrationRepoPort extends Context.Service<
  AdeIntegrationRepoPort,
  AdeIntegrationRepoPortShape
>()("shuv2code/ade/AdeIntegrationRepoPort") {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

const CONFLICT_MARKER = /there are unresolved conflicts|conflict/i;

/**
 * jj reports a rebase that would change nothing as a non-zero "nothing changed"
 * / "already in place" outcome. That is convergence — the exact state a re-run
 * of an interrupted pass lands in — and must never read as a conflict.
 */
const REBASE_NOOP_MARKER = /nothing changed|no changes|already in place|would be a no-?op/i;

/**
 * jj revsets are parsed, so a bookmark name is passed as a quoted string
 * literal — otherwise a bookmark called `root` would resolve to the `root()`
 * function. Mirrors `literalBookmarkRevision` in JjVcsDriver.
 */
const revsetLiteral = (name: string): string =>
  `"${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const trimOutput = (value: string, limit = 4_000): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`;

export const make = Effect.gen(function* () {
  const driver = yield* VcsDriver.VcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;

  const failure = (operation: string) => (cause: unknown) =>
    new AdeIntegrationRepoError({
      operation,
      detail: cause instanceof Error ? cause.message : String(cause),
    });

  /** Run `jj` in `cwd`, tolerating a non-zero exit so callers can classify it. */
  const jj = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    timeoutMs: number = ADE_JJ_LOCAL_TIMEOUT_MS,
  ) =>
    driver
      .execute({
        operation: `AdeIntegrationRepoPort.${operation}`,
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs,
      })
      .pipe(Effect.mapError(failure(operation)));

  /** Run `jj`, turning a non-zero exit into an `AdeIntegrationRepoError`. */
  const jjOrFail = Effect.fn("AdeIntegrationRepoPort.jjOrFail")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    timeoutMs: number = ADE_JJ_LOCAL_TIMEOUT_MS,
  ) {
    const result = yield* jj(operation, cwd, args, timeoutMs);
    if (result.exitCode !== 0) {
      return yield* new AdeIntegrationRepoError({
        operation,
        detail: trimOutput(`${result.stderr}\n${result.stdout}`.trim()),
      });
    }
    return result;
  });

  const revisionIsConflicted = Effect.fn("AdeIntegrationRepoPort.revisionIsConflicted")(function* (
    cwd: string,
    revisionLiteral: string,
  ) {
    const result = yield* jj("conflictProbe", cwd, [
      "log",
      "--no-graph",
      "-r",
      revisionLiteral,
      "-T",
      'if(conflict, "conflict", "clean") ++ "\\n"',
    ]);
    if (result.exitCode !== 0) return false;
    return result.stdout.includes("conflict");
  });

  /** True when `ancestor` is an ancestor of, or equal to, `descendant`. */
  const isAncestorOrEqual = Effect.fn("AdeIntegrationRepoPort.isAncestorOrEqual")(function* (
    cwd: string,
    ancestorLiteral: string,
    descendantLiteral: string,
  ) {
    const result = yield* jj("ancestryProbe", cwd, [
      "log",
      "--no-graph",
      "-r",
      `${ancestorLiteral} & ::${descendantLiteral}`,
      "-T",
      '"hit\\n"',
    ]);
    if (result.exitCode !== 0) return false;
    return result.stdout.includes("hit");
  });

  const readCanonicalCommitId = Effect.fn("AdeIntegrationRepoPort.readCanonicalCommitId")(
    function* (repoPath: string, bookmarkLiteral: string) {
      const read = yield* jj("readCanonical", repoPath, [
        "log",
        "--no-graph",
        "-r",
        bookmarkLiteral,
        "-T",
        'commit_id ++ "\\n"',
      ]);
      if (read.exitCode !== 0) return "";
      return read.stdout.trim().split("\n")[0] ?? "";
    },
  );

  const syncUpstream: AdeIntegrationRepoPortShape["syncUpstream"] = Effect.fn(
    "AdeIntegrationRepoPort.syncUpstream",
  )(function* (input: SyncUpstreamInput) {
    const bookmark = input.canonicalBookmark ?? ADE_CANONICAL_BOOKMARK;
    // A project with no remote is coherent (ADR §14.2) — local canonical is
    // already the whole truth, so the sync step is a documented no-op.
    if (input.remote === null) return { advanced: false, conflictDetail: null };

    yield* jjOrFail(
      "syncUpstream.fetch",
      input.repoPath,
      ["git", "fetch", "--remote", input.remote],
      ADE_JJ_NETWORK_TIMEOUT_MS,
    );

    const upstream = `${bookmark}@${input.remote}`;
    const upstreamExists = yield* jj("syncUpstream.probeUpstream", input.repoPath, [
      "log",
      "--no-graph",
      "-r",
      revsetLiteral(upstream),
      "-T",
      '"present\\n"',
    ]);
    if (upstreamExists.exitCode !== 0 || !upstreamExists.stdout.includes("present")) {
      return { advanced: false, conflictDetail: null };
    }

    // Rebase the local canonical branch onto upstream. jj carries bookmarks
    // with their commits, so canonical follows automatically. A no-op rebase
    // exits non-zero with "Nothing changed"; that is convergence, not failure.
    const rebase = yield* jj("syncUpstream.rebase", input.repoPath, [
      "rebase",
      "-b",
      revsetLiteral(bookmark),
      "-d",
      revsetLiteral(upstream),
    ]);
    const combined = `${rebase.stderr}\n${rebase.stdout}`.trim();
    if (rebase.exitCode !== 0 && !/nothing changed|no changes/i.test(combined)) {
      return { advanced: false, conflictDetail: trimOutput(combined) };
    }
    const conflicted = yield* revisionIsConflicted(input.repoPath, revsetLiteral(bookmark));
    if (conflicted) {
      return { advanced: false, conflictDetail: trimOutput(combined || "canonical is conflicted") };
    }
    return { advanced: !/nothing changed|no changes/i.test(combined), conflictDetail: null };
  });

  const prepareCandidateWorkspace: AdeIntegrationRepoPortShape["prepareCandidateWorkspace"] =
    Effect.fn("AdeIntegrationRepoPort.prepareCandidateWorkspace")(function* (
      input: PrepareCandidateWorkspaceInput,
    ) {
      const bookmark = input.canonicalBookmark ?? ADE_CANONICAL_BOOKMARK;
      const bookmarkLiteral = revsetLiteral(bookmark);
      if (input.changeIds.length === 0) {
        return yield* new AdeIntegrationRepoError({
          operation: "prepareCandidateWorkspace",
          detail: "a candidate must carry at least one change id",
        });
      }
      // Second defense behind the contracts-level `JjChangeId` pattern: nothing
      // reaches `jj` unquoted, and a change id that is not a plain change id is
      // refused here rather than being interpreted as a revset or a flag.
      for (const changeId of input.changeIds) {
        if (!JJ_CHANGE_ID_PATTERN.test(changeId)) {
          return yield* new AdeIntegrationRepoError({
            operation: "prepareCandidateWorkspace",
            detail: `'${changeId}' is not a plain JJ change id`,
          });
        }
      }

      // Converge first: drop whatever a crashed pass left behind so this pass
      // starts from canonical, exactly as ADR §16.2 describes.
      yield* jj("prepareCandidateWorkspace.forget", input.repoPath, [
        "workspace",
        "forget",
        "--",
        input.workspaceName,
      ]);
      yield* fileSystem
        .remove(input.workspacePath, { recursive: true, force: true })
        .pipe(Effect.mapError(failure("prepareCandidateWorkspace.removeStale")));
      yield* fileSystem
        .makeDirectory(path.dirname(input.workspacePath), { recursive: true })
        .pipe(Effect.mapError(failure("prepareCandidateWorkspace.makeParent")));

      yield* jjOrFail(
        "prepareCandidateWorkspace.add",
        input.repoPath,
        [
          "workspace",
          "add",
          "--name",
          input.workspaceName,
          "--revision",
          bookmarkLiteral,
          "--",
          input.workspacePath,
        ],
        ADE_JJ_NETWORK_TIMEOUT_MS,
      );

      const headRevision = input.changeIds[input.changeIds.length - 1] as string;
      const headLiteral = revsetLiteral(headRevision);

      // Already landed (a pass that died after advancing canonical): rebasing
      // it again reads as "cannot rebase onto descendant" and would bounce the
      // author for work that is in fact integrated.
      const alreadyLanded = yield* isAncestorOrEqual(
        input.workspacePath,
        headLiteral,
        bookmarkLiteral,
      );
      if (alreadyLanded) {
        return { workspacePath: input.workspacePath, headRevision, conflictDetail: null };
      }

      // Rebase the candidate's changes onto the just-synced canonical so the
      // reviewer sees the true final diff (ADR §7.1, §7.2).
      const rebaseArgs = [
        "rebase",
        ...input.changeIds.flatMap((changeId) => ["-r", revsetLiteral(changeId)]),
        "-d",
        bookmarkLiteral,
      ];
      const rebase = yield* jj("prepareCandidateWorkspace.rebase", input.workspacePath, rebaseArgs);
      const combined = `${rebase.stderr}\n${rebase.stdout}`.trim();
      if (rebase.exitCode !== 0 && !REBASE_NOOP_MARKER.test(combined)) {
        return {
          workspacePath: input.workspacePath,
          headRevision,
          conflictDetail: trimOutput(combined || "rebase failed"),
        };
      }

      const conflicted = yield* revisionIsConflicted(input.workspacePath, headLiteral);
      if (conflicted || (CONFLICT_MARKER.test(combined) && !REBASE_NOOP_MARKER.test(combined))) {
        return {
          workspacePath: input.workspacePath,
          headRevision,
          conflictDetail: trimOutput(combined || "rebased change is conflicted"),
        };
      }

      // Park the workspace's working copy on the rebased head so the checks
      // below (and any reviewer opening the workspace) see the candidate.
      yield* jjOrFail("prepareCandidateWorkspace.edit", input.workspacePath, [
        "edit",
        "-r",
        headLiteral,
      ]);

      return { workspacePath: input.workspacePath, headRevision, conflictDetail: null };
    });

  const shellInvocation = (
    command: string,
  ): { readonly command: string; readonly args: ReadonlyArray<string> } =>
    platform === "win32"
      ? { command: "cmd", args: ["/d", "/s", "/c", command] }
      : { command: "/bin/sh", args: ["-c", command] };

  const runChecks: AdeIntegrationRepoPortShape["runChecks"] = Effect.fn(
    "AdeIntegrationRepoPort.runChecks",
  )(function* (input: RunChecksInput) {
    const failures: Array<CheckFailure> = [];
    const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    // A project with no configured checks passes trivially — the captain's
    // choice (ADR §7.2).
    for (const command of input.checkCommands) {
      const elapsed = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) - startedAt;
      const remaining = ADE_CHECK_SUITE_TIMEOUT_MS - elapsed;
      if (remaining <= 0) {
        // The suite budget is spent: report the rest as failed rather than
        // letting a long tail hold the project's queue open indefinitely.
        failures.push({
          command,
          exitCode: null,
          output: `check suite exceeded its ${ADE_CHECK_SUITE_TIMEOUT_MS}ms budget before this command ran`,
        });
        continue;
      }
      const budget = Math.min(ADE_CHECK_TIMEOUT_MS, remaining);
      const invocation = shellInvocation(command);
      const result = yield* runner
        .run({
          command: invocation.command,
          args: [...invocation.args],
          cwd: input.workspacePath,
          timeout: budget,
          timeoutBehavior: "timedOutResult",
          outputMode: "truncate",
        })
        .pipe(Effect.mapError(failure("runChecks")));
      if (result.timedOut) {
        failures.push({
          command,
          exitCode: null,
          output: `check timed out after ${budget}ms`,
        });
        continue;
      }
      if (result.code !== 0) {
        failures.push({
          command,
          exitCode: result.code,
          output: trimOutput(`${result.stdout}\n${result.stderr}`.trim()),
        });
      }
    }
    return { passed: failures.length === 0, failures };
  });

  const canonicalState: AdeIntegrationRepoPortShape["canonicalState"] = Effect.fn(
    "AdeIntegrationRepoPort.canonicalState",
  )(function* (input: CanonicalStateInput) {
    const bookmarkLiteral = revsetLiteral(input.canonicalBookmark ?? ADE_CANONICAL_BOOKMARK);
    const headLiteral = revsetLiteral(input.headRevision);
    const canonicalCommitId = yield* readCanonicalCommitId(input.repoPath, bookmarkLiteral);
    const containsHead = yield* isAncestorOrEqual(input.repoPath, headLiteral, bookmarkLiteral);
    const fastForwardable = yield* isAncestorOrEqual(input.repoPath, bookmarkLiteral, headLiteral);
    return { containsHead, fastForwardable, canonicalCommitId };
  });

  const advanceCanonical: AdeIntegrationRepoPortShape["advanceCanonical"] = Effect.fn(
    "AdeIntegrationRepoPort.advanceCanonical",
  )(function* (input: AdvanceCanonicalInput) {
    const bookmark = input.canonicalBookmark ?? ADE_CANONICAL_BOOKMARK;
    const bookmarkLiteral = revsetLiteral(bookmark);
    const headLiteral = revsetLiteral(input.headRevision);

    const state = yield* canonicalState({
      repoPath: input.repoPath,
      headRevision: input.headRevision,
      canonicalBookmark: bookmark,
    });
    // Idempotent: the durable commit point already happened.
    if (state.containsHead) {
      return { _tag: "already-integrated", canonicalCommitId: state.canonicalCommitId } as const;
    }
    // Fast-forward only. Canonical moved somewhere this head does not descend
    // from (an upstream sync landed while the candidate sat on a gate), so
    // pointing the bookmark here would silently drop those commits. Refuse; the
    // caller re-runs the candidate against the new canonical.
    if (!state.fastForwardable) {
      return {
        _tag: "diverged",
        canonicalCommitId: state.canonicalCommitId,
        detail: `canonical ${state.canonicalCommitId} is not an ancestor of the candidate head; the candidate must be rebased again`,
      } as const;
    }

    // Only the integration service moves this bookmark (ADR §6.3). No
    // `--allow-backwards`: the ancestry check above is the only sanctioned way
    // past a non-fast-forward, and it never sanctions one.
    yield* jjOrFail("advanceCanonical.set", input.repoPath, [
      "bookmark",
      "set",
      "--revision",
      headLiteral,
      "--",
      bookmark,
    ]);
    const canonicalCommitId = yield* readCanonicalCommitId(input.repoPath, bookmarkLiteral);
    if (canonicalCommitId === "") {
      return yield* new AdeIntegrationRepoError({
        operation: "advanceCanonical.read",
        detail: "canonical bookmark resolved to no commit after advancement",
      });
    }
    return { _tag: "advanced", canonicalCommitId } as const;
  });

  const cleanupWorkspace: AdeIntegrationRepoPortShape["cleanupWorkspace"] = Effect.fn(
    "AdeIntegrationRepoPort.cleanupWorkspace",
  )(function* (input: CleanupWorkspaceInput) {
    // Both steps tolerate an already-clean state: cleanup is re-runnable.
    yield* jj("cleanupWorkspace.forget", input.repoPath, [
      "workspace",
      "forget",
      "--",
      input.workspaceName,
    ]);
    yield* fileSystem
      .remove(input.workspacePath, { recursive: true, force: true })
      .pipe(Effect.mapError(failure("cleanupWorkspace.remove")));
  });

  return AdeIntegrationRepoPort.of({
    syncUpstream,
    prepareCandidateWorkspace,
    runChecks,
    canonicalState,
    advanceCanonical,
    cleanupWorkspace,
  });
});

export const layer: Layer.Layer<
  AdeIntegrationRepoPort,
  never,
  VcsDriver.VcsDriver | FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> = Layer.effect(AdeIntegrationRepoPort, make);
