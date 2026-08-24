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

export interface AdvanceCanonicalResult {
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
  const jj = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    driver
      .execute({
        operation: `AdeIntegrationRepoPort.${operation}`,
        cwd,
        args,
        allowNonZeroExit: true,
      })
      .pipe(Effect.mapError(failure(operation)));

  /** Run `jj`, turning a non-zero exit into an `AdeIntegrationRepoError`. */
  const jjOrFail = Effect.fn("AdeIntegrationRepoPort.jjOrFail")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* jj(operation, cwd, args);
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
    revision: string,
  ) {
    const result = yield* jj("conflictProbe", cwd, [
      "log",
      "--no-graph",
      "-r",
      revision,
      "-T",
      'if(conflict, "conflict", "clean") ++ "\\n"',
    ]);
    if (result.exitCode !== 0) return false;
    return result.stdout.includes("conflict");
  });

  const syncUpstream: AdeIntegrationRepoPortShape["syncUpstream"] = Effect.fn(
    "AdeIntegrationRepoPort.syncUpstream",
  )(function* (input: SyncUpstreamInput) {
    const bookmark = input.canonicalBookmark ?? ADE_CANONICAL_BOOKMARK;
    // A project with no remote is coherent (ADR §14.2) — local canonical is
    // already the whole truth, so the sync step is a documented no-op.
    if (input.remote === null) return { advanced: false, conflictDetail: null };

    yield* jjOrFail("syncUpstream.fetch", input.repoPath, [
      "git",
      "fetch",
      "--remote",
      input.remote,
    ]);

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
      if (input.changeIds.length === 0) {
        return yield* new AdeIntegrationRepoError({
          operation: "prepareCandidateWorkspace",
          detail: "a candidate must carry at least one change id",
        });
      }

      // Converge first: drop whatever a crashed pass left behind so this pass
      // starts from canonical, exactly as ADR §16.2 describes.
      yield* jj("prepareCandidateWorkspace.forget", input.repoPath, [
        "workspace",
        "forget",
        input.workspaceName,
      ]);
      yield* fileSystem
        .remove(input.workspacePath, { recursive: true, force: true })
        .pipe(Effect.mapError(failure("prepareCandidateWorkspace.removeStale")));
      yield* fileSystem
        .makeDirectory(path.dirname(input.workspacePath), { recursive: true })
        .pipe(Effect.mapError(failure("prepareCandidateWorkspace.makeParent")));

      yield* jjOrFail("prepareCandidateWorkspace.add", input.repoPath, [
        "workspace",
        "add",
        "--name",
        input.workspaceName,
        "--revision",
        revsetLiteral(bookmark),
        input.workspacePath,
      ]);

      // Rebase the candidate's changes onto the just-synced canonical so the
      // reviewer sees the true final diff (ADR §7.1, §7.2).
      const rebaseArgs = [
        "rebase",
        ...input.changeIds.flatMap((changeId) => ["-r", changeId]),
        "-d",
        revsetLiteral(bookmark),
      ];
      const rebase = yield* jj("prepareCandidateWorkspace.rebase", input.workspacePath, rebaseArgs);
      const combined = `${rebase.stderr}\n${rebase.stdout}`.trim();
      const headRevision = input.changeIds[input.changeIds.length - 1] as string;
      if (rebase.exitCode !== 0 && !/nothing changed|no changes/i.test(combined)) {
        return {
          workspacePath: input.workspacePath,
          headRevision,
          conflictDetail: trimOutput(combined || "rebase failed"),
        };
      }

      const conflicted = yield* revisionIsConflicted(input.workspacePath, headRevision);
      if (conflicted || CONFLICT_MARKER.test(combined)) {
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
        headRevision,
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
    // A project with no configured checks passes trivially — the captain's
    // choice (ADR §7.2).
    for (const command of input.checkCommands) {
      const invocation = shellInvocation(command);
      const result = yield* runner
        .run({
          command: invocation.command,
          args: [...invocation.args],
          cwd: input.workspacePath,
          timeout: ADE_CHECK_TIMEOUT_MS,
          timeoutBehavior: "timedOutResult",
          outputMode: "truncate",
        })
        .pipe(Effect.mapError(failure("runChecks")));
      if (result.timedOut) {
        failures.push({
          command,
          exitCode: null,
          output: `check timed out after ${ADE_CHECK_TIMEOUT_MS}ms`,
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

  const advanceCanonical: AdeIntegrationRepoPortShape["advanceCanonical"] = Effect.fn(
    "AdeIntegrationRepoPort.advanceCanonical",
  )(function* (input: AdvanceCanonicalInput) {
    const bookmark = input.canonicalBookmark ?? ADE_CANONICAL_BOOKMARK;
    // Only the integration service moves this bookmark (ADR §6.3).
    yield* jjOrFail("advanceCanonical.set", input.repoPath, [
      "bookmark",
      "set",
      bookmark,
      "--revision",
      input.headRevision,
      "--allow-backwards",
    ]);
    const read = yield* jjOrFail("advanceCanonical.read", input.repoPath, [
      "log",
      "--no-graph",
      "-r",
      revsetLiteral(bookmark),
      "-T",
      'commit_id ++ "\\n"',
    ]);
    const canonicalCommitId = read.stdout.trim().split("\n")[0] ?? "";
    if (canonicalCommitId === "") {
      return yield* new AdeIntegrationRepoError({
        operation: "advanceCanonical.read",
        detail: "canonical bookmark resolved to no commit after advancement",
      });
    }
    return { canonicalCommitId };
  });

  const cleanupWorkspace: AdeIntegrationRepoPortShape["cleanupWorkspace"] = Effect.fn(
    "AdeIntegrationRepoPort.cleanupWorkspace",
  )(function* (input: CleanupWorkspaceInput) {
    // Both steps tolerate an already-clean state: cleanup is re-runnable.
    yield* jj("cleanupWorkspace.forget", input.repoPath, [
      "workspace",
      "forget",
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
    advanceCanonical,
    cleanupWorkspace,
  });
});

export const layer: Layer.Layer<
  AdeIntegrationRepoPort,
  never,
  VcsDriver.VcsDriver | FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> = Layer.effect(AdeIntegrationRepoPort, make);
