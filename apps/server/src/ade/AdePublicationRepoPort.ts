/**
 * The mechanics half of the ADE publication service (spec §4.5, ADR §8, §14.5,
 * §16.3; spike [#134](https://github.com/shuv1337/shuv2code/issues/134)).
 *
 * `AdePublicationService` owns *policy*: which layers exist, in what order, and
 * what the next pass should do about them. This port owns *mechanics*: `jj git
 * fetch`, bookmark placement, ref pushes, `gh` reads and writes, SHA-keyed
 * ancestry probes, and the `--skip-emptied` refresh. Splitting them is what
 * lets the state machine run against a deterministic stub while one runtime
 * test drives real `jj` against a real scratch repository.
 *
 * Four properties of this file are load-bearing, and each of them is a spike
 * finding rather than a preference:
 *
 * 1. **Every jj invocation carries `--ignore-working-copy`.** jj snapshots the
 *    working copy on *every* command and folds whatever it finds into `@`. That
 *    bit the spike twice. Suppressing the snapshot is what makes spec §4.5
 *    invariant 4 ("never writes files inside operated workspaces") structural
 *    instead of aspirational: the publish pass cannot alter the operated tree
 *    even by accident, because jj is never allowed to look at it.
 * 2. **Bookmark names are pattern-constrained *and* passed as `exact:`.**
 *    `jj git push --bookmark` interprets its argument as a *glob* by default —
 *    verified: `--bookmark 'feat*'` pushes `feature-x` too. A layer bookmark
 *    carrying a `*` would therefore publish branches nobody asked for. The
 *    pattern refuses glob metacharacters and `exact:` refuses to glob what does
 *    get through.
 * 3. **Ancestry before any ref move.** `ensureBookmark` asks whether the target
 *    descends from where the bookmark currently sits and only reaches for
 *    `--allow-backwards` when it does not, mirroring the gate
 *    `AdeIntegrationRepoPort.advanceCanonical` puts in front of canonical.
 * 4. **`--delete-branch` appears nowhere.** Deleting a publication branch
 *    mid-stack cascade-closes every dependent PR (spike P3/P4); deletion is
 *    `deleteBookmarks`, called only by the explicit post-reconcile cleanup pass
 *    (spec §4.5 invariant 5).
 *
 * `jj` rides the existing `VcsDriver.execute` seam and `gh` rides the existing
 * `GitHubCli.execute` seam, so ADE gains no third process-spawning path and
 * tests mock GitHub the way the rest of the codebase does.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { JJ_CHANGE_ID_PATTERN } from "@shuv2code/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A mechanical failure that is *not* a verdict about the stack: the repository
 * or GitHub could not be operated at all. The service treats it as a transient
 * pass failure and leaves the stack where it is, because a publication pass is
 * re-entrant by construction (ADR §16.3) and re-running it is free.
 */
export class AdePublicationRepoError extends Schema.TaggedErrorClass<AdePublicationRepoError>()(
  "AdePublicationRepoError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ADE publication repository operation '${this.operation}' failed: ${this.detail}`;
  }
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

/**
 * Publication bookmark names double as Git branch names and as `jj git push`
 * patterns, so the accepted alphabet is the intersection of what Git accepts
 * and what carries no glob meaning: no `*`, `?`, `[`, `]`, `{`, `}`, no `~`,
 * `^`, `:`, `\`, and no whitespace. `refValidationDetail` below rejects the
 * remaining Git-specific shapes the character class alone cannot express.
 */
export const ADE_PUBLICATION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/**
 * Returns a reason string when `name` is not usable as a publication branch, or
 * `null` when it is. Every dynamic ref that reaches `jj` or `gh` goes through
 * here first — branch names originate in candidate data, so they are untrusted
 * input in exactly the way S10's change ids were.
 */
export const refValidationDetail = (name: string): string | null => {
  if (!ADE_PUBLICATION_REF_PATTERN.test(name)) {
    return `'${name}' is not an acceptable publication branch name`;
  }
  if (name.includes("..")) return `'${name}' contains '..'`;
  if (name.includes("//")) return `'${name}' contains an empty path segment`;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) {
    return `'${name}' has an invalid trailing component`;
  }
  // `@` alone is jj's working-copy symbol and Git rejects it as a ref name.
  if (name === "@" || name === "HEAD") return `'${name}' is a reserved ref name`;
  return null;
};

const requireRef = (operation: string, name: string) =>
  Effect.gen(function* () {
    const detail = refValidationDetail(name);
    if (detail !== null) {
      return yield* new AdePublicationRepoError({ operation, detail });
    }
    return name;
  });

const requireChangeId = (operation: string, changeId: string) =>
  Effect.gen(function* () {
    if (!JJ_CHANGE_ID_PATTERN.test(changeId)) {
      return yield* new AdePublicationRepoError({
        operation,
        detail: `'${changeId}' is not a plain JJ change id`,
      });
    }
    return changeId;
  });

/**
 * A GitHub commit SHA. Constrained because recorded SHAs are interpolated into
 * jj revsets during reconciliation, and a "SHA" that is really a revset would
 * turn an ancestry probe into arbitrary revision selection.
 */
export const ADE_PUBLICATION_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

const requireSha = (operation: string, sha: string) =>
  Effect.gen(function* () {
    if (!ADE_PUBLICATION_SHA_PATTERN.test(sha)) {
      return yield* new AdePublicationRepoError({
        operation,
        detail: `'${sha}' is not a commit SHA`,
      });
    }
    return sha;
  });

const requirePrNumber = (operation: string, prNumber: number) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
      return yield* new AdePublicationRepoError({
        operation,
        detail: `'${prNumber}' is not a pull request number`,
      });
    }
    return String(prNumber);
  });

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

/**
 * Explicit, generous deadlines rather than VcsProcess's 30s default and
 * GitHubCli's 30s default. A fetch or a whole-stack merge legitimately runs for
 * minutes; a pass that silently hangs forever is worse than a loud failure.
 */
export const ADE_PUBLICATION_JJ_NETWORK_TIMEOUT_MS = 10 * 60 * 1000;
export const ADE_PUBLICATION_JJ_LOCAL_TIMEOUT_MS = 5 * 60 * 1000;
export const ADE_PUBLICATION_GH_READ_TIMEOUT_MS = 2 * 60 * 1000;
export const ADE_PUBLICATION_GH_WRITE_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Port shape
// ---------------------------------------------------------------------------

export type PublicationPrState = "open" | "closed" | "merged";

/** Fresh GitHub truth about one PR. Never cached across passes (invariant 1). */
export interface PublishedPullRequest {
  readonly number: number;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly state: PublicationPrState;
  readonly isDraft: boolean;
  /** The PR head commit GitHub currently sees; `null` when the branch is gone. */
  readonly headSha: string | null;
  /** Set only once merged — the SHA post-merge reconciliation keys on. */
  readonly mergeSha: string | null;
}

/** A native GitHub Stack object (ADR §8.3: presentation, not durable truth). */
export interface NativeStack {
  readonly number: number;
  readonly nodeId: string | null;
  readonly url: string | null;
  readonly open: boolean;
  readonly pullRequestNumbers: ReadonlyArray<number>;
}

export interface EnsureBookmarkResult {
  /** The commit the bookmark now points at. */
  readonly headSha: string;
  /** True when this pass created a bookmark that was missing. */
  readonly recreated: boolean;
  /** True when this pass moved an existing bookmark to a new commit. */
  readonly moved: boolean;
}

export interface RefreshStackResult {
  /**
   * False when the change id no longer resolves. `--skip-emptied` abandons a
   * layer whose content has landed, so its change id stops existing; the caller
   * distinguishes that from "nothing to do" by re-trying from the bottom of the
   * surviving tail.
   */
  readonly resolved: boolean;
  /** True when the rebase actually moved something. */
  readonly rebased: boolean;
  /** Set when the refresh conflicted; the caller blocks rather than forcing. */
  readonly conflictDetail: string | null;
}

/**
 * `gh stack link` either linked the branches, or told us this host has no
 * stacked-PR surface at all. The second answer is a capability fact, so it is a
 * value rather than an error: the service downgrades the stack to the chained
 * fallback and keeps going in the same pass.
 */
export type LinkStackResult =
  | { readonly _tag: "linked" }
  | { readonly _tag: "unsupported"; readonly detail: string };

export interface WorkingCopyFingerprint {
  readonly commitId: string;
  readonly changeId: string;
}

export interface AdePublicationRepoPortShape {
  /**
   * Converge-then-act, step one (spec §4.5 invariant 1). `jj git push` is
   * idempotent only against jj's *last-fetched* view of the remote: after an
   * out-of-band branch deletion it reports "already matches" and repairs
   * nothing. Every pass therefore begins here.
   */
  readonly fetch: (input: {
    readonly repoPath: string;
    readonly remote: string | null;
  }) => Effect.Effect<void, AdePublicationRepoError>;

  /**
   * Converge-then-act, step two: fresh `gh` reads keyed by head branch. This is
   * the adopt-by-head-branch primitive — a replacement PR is discovered here,
   * by branch, without the caller knowing its number in advance (invariant 2).
   */
  readonly readPullRequestsByHeadBranch: (input: {
    readonly repoPath: string;
    readonly bookmarkNames: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<PublishedPullRequest>, AdePublicationRepoError>;

  /**
   * Place a layer bookmark on its recorded change. The durable `changeId` is
   * what recreates a bookmark that a fetch deleted because the remote branch
   * vanished (invariant 1).
   */
  readonly ensureBookmark: (input: {
    readonly repoPath: string;
    readonly bookmarkName: string;
    readonly changeId: string;
  }) => Effect.Effect<EnsureBookmarkResult, AdePublicationRepoError>;

  /** The commit a bookmark points at, or `null` when it does not exist. */
  readonly readBookmarkSha: (input: {
    readonly repoPath: string;
    readonly bookmarkName: string;
  }) => Effect.Effect<string | null, AdePublicationRepoError>;

  /** Ref-only push. Never `--delete-branch`, never a bare glob. */
  readonly pushBookmarks: (input: {
    readonly repoPath: string;
    readonly remote: string;
    readonly bookmarkNames: ReadonlyArray<string>;
  }) => Effect.Effect<void, AdePublicationRepoError>;

  /**
   * The explicit post-reconcile cleanup pass (invariant 5). Deleting a
   * publication branch at any other moment cascade-closes dependent PRs.
   */
  readonly deleteBookmarks: (input: {
    readonly repoPath: string;
    readonly remote: string | null;
    readonly bookmarkNames: ReadonlyArray<string>;
  }) => Effect.Effect<void, AdePublicationRepoError>;

  /**
   * Promote pushed bookmarks to a native GitHub Stack. `gh stack link` is
   * designed for jj users (no local tracking state) and creates the missing
   * PRs itself, correctly chained.
   */
  readonly linkStack: (input: {
    readonly repoPath: string;
    readonly baseBranch: string;
    readonly bookmarkNames: ReadonlyArray<string>;
  }) => Effect.Effect<LinkStackResult, AdePublicationRepoError>;

  /** Fresh read of the repository's native Stack objects. */
  readonly readNativeStacks: (input: {
    readonly repoPath: string;
  }) => Effect.Effect<ReadonlyArray<NativeStack>, AdePublicationRepoError>;

  /** `gh stack link` creates drafts, and `gh stack merge` refuses drafts. */
  readonly markPullRequestsReady: (input: {
    readonly repoPath: string;
    readonly prNumbers: ReadonlyArray<number>;
  }) => Effect.Effect<void, AdePublicationRepoError>;

  /** Atomic whole-stack merge (ADR §8.3). All-or-nothing, no branch deletion. */
  readonly mergeStack: (input: {
    readonly repoPath: string;
    readonly stackNumber: number;
    readonly mergeMethod: "squash" | "merge" | "rebase";
  }) => Effect.Effect<void, AdePublicationRepoError>;

  // -- chained-PR fallback (identical jj-side mechanics, ADR §8.1) ----------

  readonly createPullRequest: (input: {
    readonly repoPath: string;
    readonly baseBranch: string;
    readonly bookmarkName: string;
    readonly title: string;
    readonly body: string;
  }) => Effect.Effect<void, AdePublicationRepoError>;

  /** Base is computed every pass, so drift is repaired rather than recorded. */
  readonly retargetPullRequest: (input: {
    readonly repoPath: string;
    readonly prNumber: number;
    readonly baseBranch: string;
  }) => Effect.Effect<void, AdePublicationRepoError>;

  readonly mergePullRequest: (input: {
    readonly repoPath: string;
    readonly prNumber: number;
    readonly mergeMethod: "squash" | "merge" | "rebase";
  }) => Effect.Effect<void, AdePublicationRepoError>;

  // -- reconciliation ------------------------------------------------------

  /**
   * SHA-keyed landing detection (invariant 3). Returns the subset of `shas`
   * that are ancestors of `baseRevision`. Change ids stop resolving once their
   * layer merges, and branch names are reused and deleted out of band, so the
   * recorded merge SHA is the only durable key.
   */
  readonly landedShas: (input: {
    readonly repoPath: string;
    readonly baseBookmark: string;
    readonly remote: string;
    readonly shas: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<string>, AdePublicationRepoError>;

  /**
   * `jj rebase -s <bottom> -d <onto> --skip-emptied` — the §14.5 refresh and
   * the post-merge reconciliation, which are the same operation. `--skip-emptied`
   * proves content equivalence and abandons layers whose content already landed,
   * carrying the unpublished tail along.
   */
  readonly refreshStack: (input: {
    readonly repoPath: string;
    readonly bottomChangeId: string;
    readonly baseBookmark: string;
    readonly remote: string;
  }) => Effect.Effect<RefreshStackResult, AdePublicationRepoError>;

  /**
   * Evidence for invariant 4. A publish pass must leave this identical: the
   * working copy is read, never written, and `@` is never moved.
   */
  readonly workingCopyFingerprint: (input: {
    readonly repoPath: string;
  }) => Effect.Effect<WorkingCopyFingerprint, AdePublicationRepoError>;
}

export class AdePublicationRepoPort extends Context.Service<
  AdePublicationRepoPort,
  AdePublicationRepoPortShape
>()("shuv2code/ade/AdePublicationRepoPort") {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

/**
 * jj revsets are parsed, so every dynamic value is a quoted string literal —
 * otherwise a bookmark called `root` resolves to the `root()` function. Mirrors
 * `literalBookmarkRevision` in JjVcsDriver.
 */
const revsetLiteral = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * A remote bookmark is `<bookmark>@<remote>`, and only the two halves may be
 * quoted — `"main@origin"` is parsed as a single symbol and does not resolve.
 * That distinction is why the base is carried as a bookmark plus a remote
 * rather than as one pre-joined string.
 */
const remoteBookmarkRevset = (bookmark: string, remote: string): string =>
  `${revsetLiteral(bookmark)}@${revsetLiteral(remote)}`;

const trimOutput = (value: string, limit = 4_000): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`;

/** jj reports a rebase that would change nothing as a non-zero "nothing changed". */
const NOOP_MARKER = /nothing changed|no changes|already in place|already matches/i;
const MISSING_REVISION_MARKER = /revision .*(doesn't|does not) exist|no such revision/i;
/**
 * jj's actual unresolved-conflict phrasing, verified against 0.40: a rebase
 * that produces conflicts still exits 0 and prints "New conflicts appeared in
 * N commits". A bare /conflict/i would also fire on the resolution hint text
 * and on any commit description containing the word.
 */
const CONFLICT_MARKER = /there are unresolved conflicts|new conflicts appeared in/i;

/**
 * `gh` on a host without the stacked-PR surface: the subcommand is unknown, or
 * the REST endpoint 404s. That is a capability answer, not a failure, and the
 * caller downgrades to the chained fallback rather than retrying forever.
 */
const STACK_UNSUPPORTED_MARKER =
  /unknown command|unknown subcommand|no such command|unrecognized command|HTTP 404|not found|is not a gh command/i;

const RawPullRequest = Schema.Struct({
  number: Schema.Number,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  state: Schema.String,
  isDraft: Schema.optional(Schema.Boolean),
  headRefOid: Schema.optional(Schema.NullOr(Schema.String)),
  mergeCommit: Schema.optional(Schema.NullOr(Schema.Struct({ oid: Schema.String }))),
});

const decodePullRequests = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(RawPullRequest)),
);

const RawNativeStack = Schema.Struct({
  number: Schema.Number,
  node_id: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  open: Schema.optional(Schema.Boolean),
  pull_requests: Schema.optional(Schema.Array(Schema.Struct({ number: Schema.Number }))),
});

const decodeNativeStacks = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(RawNativeStack)),
);

/** GitHub reports PR state in upper case; anything unrecognized reads closed. */
const normalizePrState = (state: string): PublicationPrState =>
  state.toUpperCase() === "OPEN" ? "open" : state.toUpperCase() === "MERGED" ? "merged" : "closed";

export const make = Effect.gen(function* () {
  const driver = yield* VcsDriver.VcsDriver;
  const gh = yield* GitHubCli.GitHubCli;

  const failure = (operation: string) => (cause: unknown) =>
    new AdePublicationRepoError({
      operation,
      detail: cause instanceof Error ? cause.message : String(cause),
    });

  /**
   * Run `jj`, tolerating a non-zero exit so callers can classify it.
   *
   * `--ignore-working-copy` leads every invocation. This is spec §4.5
   * invariant 4 made structural: jj cannot snapshot, and therefore cannot
   * rewrite, the tree of the workspace this pass operates on.
   */
  const jj = (
    operation: string,
    repoPath: string,
    args: ReadonlyArray<string>,
    timeoutMs: number = ADE_PUBLICATION_JJ_LOCAL_TIMEOUT_MS,
  ) =>
    driver
      .execute({
        operation: `AdePublicationRepoPort.${operation}`,
        cwd: repoPath,
        args: ["--ignore-working-copy", ...args],
        allowNonZeroExit: true,
        timeoutMs,
      })
      .pipe(Effect.mapError(failure(operation)));

  const jjOrFail = Effect.fn("AdePublicationRepoPort.jjOrFail")(function* (
    operation: string,
    repoPath: string,
    args: ReadonlyArray<string>,
    timeoutMs: number = ADE_PUBLICATION_JJ_LOCAL_TIMEOUT_MS,
  ) {
    const result = yield* jj(operation, repoPath, args, timeoutMs);
    if (result.exitCode !== 0) {
      return yield* new AdePublicationRepoError({
        operation,
        detail: trimOutput(`${result.stderr}\n${result.stdout}`.trim()),
      });
    }
    return result;
  });

  const ghRun = Effect.fn("AdePublicationRepoPort.ghRun")(function* (
    operation: string,
    repoPath: string,
    args: ReadonlyArray<string>,
    timeoutMs: number = ADE_PUBLICATION_GH_READ_TIMEOUT_MS,
  ) {
    return yield* gh
      .execute({ cwd: repoPath, args, timeoutMs })
      .pipe(Effect.mapError(failure(operation)));
  });

  /** True when `ancestor` is an ancestor of, or equal to, `descendant`. */
  const isAncestorOrEqual = Effect.fn("AdePublicationRepoPort.isAncestorOrEqual")(function* (
    repoPath: string,
    ancestorLiteral: string,
    descendantLiteral: string,
  ) {
    const result = yield* jj("ancestryProbe", repoPath, [
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

  const readRevisionCommitId = Effect.fn("AdePublicationRepoPort.readRevisionCommitId")(function* (
    repoPath: string,
    revisionLiteral: string,
  ) {
    const result = yield* jj("readCommitId", repoPath, [
      "log",
      "--no-graph",
      "-r",
      revisionLiteral,
      "-T",
      'commit_id ++ "\\n"',
    ]);
    if (result.exitCode !== 0) return null;
    const line = result.stdout.trim().split("\n")[0] ?? "";
    return line.length === 0 ? null : line;
  });

  // -------------------------------------------------------------------------
  // Converge
  // -------------------------------------------------------------------------

  const fetch: AdePublicationRepoPortShape["fetch"] = Effect.fn("AdePublicationRepoPort.fetch")(
    function* (input) {
      // A project with no remote is coherent (ADR §14.2): there is no remote
      // truth to converge on, so the step is a documented no-op rather than an
      // error. Publication itself will refuse such a project higher up.
      if (input.remote === null) return;
      yield* requireRef("fetch", input.remote);
      yield* jjOrFail(
        "fetch",
        input.repoPath,
        [
          // Without this, converge-then-act eats itself. `git.abandon-unreachable-commits`
          // defaults to true, so the very fetch that reveals an out-of-band branch
          // deletion also *abandons* the commits that branch pointed at — and the
          // durable change id spec §4.5 invariant 1 relies on to recreate the
          // bookmark then resolves to nothing. Verified against jj 0.40: with the
          // default, a repair pass loses the layer entirely.
          "--config",
          "git.abandon-unreachable-commits=false",
          "git",
          "fetch",
          "--remote",
          input.remote,
        ],
        ADE_PUBLICATION_JJ_NETWORK_TIMEOUT_MS,
      );
    },
  );

  const readPullRequestsByHeadBranch: AdePublicationRepoPortShape["readPullRequestsByHeadBranch"] =
    Effect.fn("AdePublicationRepoPort.readPullRequestsByHeadBranch")(function* (input) {
      const found: Array<PublishedPullRequest> = [];
      for (const bookmarkName of input.bookmarkNames) {
        yield* requireRef("readPullRequestsByHeadBranch", bookmarkName);
        // `--state all` on purpose: a cascade-closed PR is exactly the state
        // the repair path needs to see, and a merged one carries the merge SHA
        // reconciliation keys on. Assuming "open" would hide both.
        const result = yield* ghRun("readPullRequestsByHeadBranch", input.repoPath, [
          "pr",
          "list",
          "--head",
          bookmarkName,
          "--state",
          "all",
          "--limit",
          "20",
          "--json",
          "number,headRefName,baseRefName,state,isDraft,headRefOid,mergeCommit",
        ]);
        const raw = result.stdout.trim();
        if (raw.length === 0) continue;
        const decoded = yield* decodePullRequests(raw).pipe(
          Effect.mapError(failure("readPullRequestsByHeadBranch.decode")),
        );
        for (const pr of decoded) {
          // gh matches `--head` loosely enough to be worth re-checking; a PR
          // for a different branch must never be adopted onto this layer.
          if (pr.headRefName !== bookmarkName) continue;
          found.push({
            number: pr.number,
            headRefName: pr.headRefName,
            baseRefName: pr.baseRefName,
            state: normalizePrState(pr.state),
            isDraft: pr.isDraft ?? false,
            headSha: pr.headRefOid ?? null,
            mergeSha: pr.mergeCommit?.oid ?? null,
          });
        }
      }
      return found;
    });

  // -------------------------------------------------------------------------
  // Bookmarks
  // -------------------------------------------------------------------------

  const readBookmarkSha: AdePublicationRepoPortShape["readBookmarkSha"] = Effect.fn(
    "AdePublicationRepoPort.readBookmarkSha",
  )(function* (input) {
    yield* requireRef("readBookmarkSha", input.bookmarkName);
    return yield* readRevisionCommitId(input.repoPath, revsetLiteral(input.bookmarkName));
  });

  const ensureBookmark: AdePublicationRepoPortShape["ensureBookmark"] = Effect.fn(
    "AdePublicationRepoPort.ensureBookmark",
  )(function* (input) {
    yield* requireRef("ensureBookmark", input.bookmarkName);
    yield* requireChangeId("ensureBookmark", input.changeId);
    const changeLiteral = revsetLiteral(input.changeId);

    const targetSha = yield* readRevisionCommitId(input.repoPath, changeLiteral);
    if (targetSha === null) {
      return yield* new AdePublicationRepoError({
        operation: "ensureBookmark",
        detail: `change '${input.changeId}' does not resolve; it may already be merged and reconciled`,
      });
    }

    const currentSha = yield* readRevisionCommitId(
      input.repoPath,
      revsetLiteral(input.bookmarkName),
    );
    if (currentSha === targetSha) {
      return { headSha: targetSha, recreated: false, moved: false };
    }

    // A backwards move is the shape that silently drops published commits, so
    // it needs the same ancestry gate `advanceCanonical` applies to canonical:
    // either the bookmark is absent (recreate it) or the target is a descendant
    // of where it sits (a normal stack refresh). `--allow-backwards` is passed
    // only when the caller has already proven the move is not a regression.
    const forwards =
      currentSha === null
        ? true
        : yield* isAncestorOrEqual(input.repoPath, revsetLiteral(currentSha), changeLiteral);

    yield* jjOrFail("ensureBookmark.set", input.repoPath, [
      "bookmark",
      "set",
      "--revision",
      changeLiteral,
      // A stack rewrite legitimately moves a bookmark sideways (the change is
      // rewritten, not advanced), which is not a fast-forward. That is the
      // §14.5 refresh, so it is allowed — but only with the ancestry answer
      // recorded above, never blindly.
      ...(forwards ? [] : ["--allow-backwards"]),
      "--",
      input.bookmarkName,
    ]);

    return { headSha: targetSha, recreated: currentSha === null, moved: currentSha !== null };
  });

  const pushBookmarks: AdePublicationRepoPortShape["pushBookmarks"] = Effect.fn(
    "AdePublicationRepoPort.pushBookmarks",
  )(function* (input) {
    if (input.bookmarkNames.length === 0) return;
    yield* requireRef("pushBookmarks", input.remote);
    for (const bookmarkName of input.bookmarkNames) {
      yield* requireRef("pushBookmarks", bookmarkName);
    }
    // `exact:` defeats jj's default glob interpretation of `--bookmark`. The
    // ref pattern already rejects glob metacharacters; this is the second
    // defense, and it is the one that survives a future pattern relaxation.
    yield* jjOrFail(
      "pushBookmarks",
      input.repoPath,
      [
        "git",
        "push",
        "--remote",
        input.remote,
        ...input.bookmarkNames.flatMap((name) => ["--bookmark", `exact:${name}`]),
      ],
      ADE_PUBLICATION_JJ_NETWORK_TIMEOUT_MS,
    );
  });

  const deleteBookmarks: AdePublicationRepoPortShape["deleteBookmarks"] = Effect.fn(
    "AdePublicationRepoPort.deleteBookmarks",
  )(function* (input) {
    if (input.bookmarkNames.length === 0) return;
    const present: Array<string> = [];
    for (const bookmarkName of input.bookmarkNames) {
      yield* requireRef("deleteBookmarks", bookmarkName);
      const sha = yield* readRevisionCommitId(input.repoPath, revsetLiteral(bookmarkName));
      if (sha !== null) present.push(bookmarkName);
    }
    if (present.length === 0) return;

    // `bookmark delete` marks the bookmark deleted locally; the deletion only
    // reaches the remote on the next push. Both halves tolerate an already-clean
    // state, because cleanup is re-runnable like every other pass.
    yield* jjOrFail("deleteBookmarks.delete", input.repoPath, [
      "bookmark",
      "delete",
      "--",
      ...present,
    ]);
    if (input.remote === null) return;
    yield* requireRef("deleteBookmarks", input.remote);
    // The push is the half that actually removes the remote branch, so its exit
    // code is load-bearing: a caller that reports "deleted" for branches which
    // survived would hide leaked publication refs forever.
    yield* jjOrFail(
      "deleteBookmarks.push",
      input.repoPath,
      [
        "git",
        "push",
        "--remote",
        input.remote,
        ...present.flatMap((name) => ["--bookmark", `exact:${name}`]),
      ],
      ADE_PUBLICATION_JJ_NETWORK_TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------
  // GitHub: native stack
  // -------------------------------------------------------------------------

  const linkStack: AdePublicationRepoPortShape["linkStack"] = Effect.fn(
    "AdePublicationRepoPort.linkStack",
  )(function* (input) {
    if (input.bookmarkNames.length === 0) return { _tag: "linked" } as const;
    yield* requireRef("linkStack", input.baseBranch);
    for (const bookmarkName of input.bookmarkNames) {
      yield* requireRef("linkStack", bookmarkName);
    }
    const result = yield* ghRun(
      "linkStack",
      input.repoPath,
      ["stack", "link", "--base", input.baseBranch, "--", ...input.bookmarkNames],
      ADE_PUBLICATION_GH_WRITE_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      const detail = trimOutput(`${result.stderr}\n${result.stdout}`.trim());
      // "This host has no stacked-PR surface" is an answer, not a failure. An
      // unrecognized failure still raises, because retrying *is* right for a
      // rate limit or a network blip — only a capability gap never resolves.
      if (STACK_UNSUPPORTED_MARKER.test(detail)) {
        return { _tag: "unsupported", detail } as const;
      }
      return yield* new AdePublicationRepoError({ operation: "linkStack", detail });
    }
    return { _tag: "linked" } as const;
  });

  const readNativeStacks: AdePublicationRepoPortShape["readNativeStacks"] = Effect.fn(
    "AdePublicationRepoPort.readNativeStacks",
  )(function* (input) {
    // `{owner}`/`{repo}` are resolved by `gh` from the repository in `cwd`, so
    // no slug lookup is needed and no dynamic value enters the path.
    const result = yield* ghRun("readNativeStacks", input.repoPath, [
      "api",
      "repos/{owner}/{repo}/stacks",
    ]);
    // A host without the stacked-PR surface 404s here. Reporting "no stacks" is
    // the honest answer and lets the caller's downgrade path run; only a
    // *successful* response that fails to parse is a real error.
    if (result.exitCode !== 0) return [];
    const raw = result.stdout.trim();
    if (raw.length === 0) return [];
    const decoded = yield* decodeNativeStacks(raw).pipe(
      Effect.mapError(failure("readNativeStacks.decode")),
    );
    return decoded.map((stack) => ({
      number: stack.number,
      nodeId: stack.node_id ?? null,
      url: stack.html_url ?? null,
      open: stack.open ?? true,
      pullRequestNumbers: (stack.pull_requests ?? []).map((pr) => pr.number),
    }));
  });

  const markPullRequestsReady: AdePublicationRepoPortShape["markPullRequestsReady"] = Effect.fn(
    "AdePublicationRepoPort.markPullRequestsReady",
  )(function* (input) {
    for (const prNumber of input.prNumbers) {
      const reference = yield* requirePrNumber("markPullRequestsReady", prNumber);
      const result = yield* ghRun("markPullRequestsReady", input.repoPath, [
        "pr",
        "ready",
        reference,
      ]);
      if (result.exitCode === 0) continue;
      const detail = trimOutput(`${result.stderr}\n${result.stdout}`.trim());
      // Already-ready is the common case on a re-run and is convergence.
      // Anything else must raise: `gh stack merge` refuses drafts, so silently
      // swallowing this failure turns into a merge that never happens.
      if (/already (open for review|ready)|not a draft/i.test(detail)) continue;
      return yield* new AdePublicationRepoError({ operation: "markPullRequestsReady", detail });
    }
  });

  const mergeStack: AdePublicationRepoPortShape["mergeStack"] = Effect.fn(
    "AdePublicationRepoPort.mergeStack",
  )(function* (input) {
    const stackNumber = yield* requirePrNumber("mergeStack", input.stackNumber);
    // `--yes` because ADE is never an interactive terminal. No `--delete-branch`
    // flag exists on `gh stack merge`, and none is wanted: branch removal is the
    // separate cleanup pass (invariant 5).
    const result = yield* ghRun(
      "mergeStack",
      input.repoPath,
      ["stack", "merge", stackNumber, "--yes", `--${input.mergeMethod}`],
      ADE_PUBLICATION_GH_WRITE_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      return yield* new AdePublicationRepoError({
        operation: "mergeStack",
        detail: trimOutput(`${result.stderr}\n${result.stdout}`.trim()),
      });
    }
  });

  // -------------------------------------------------------------------------
  // GitHub: chained-PR fallback
  // -------------------------------------------------------------------------

  const createPullRequest: AdePublicationRepoPortShape["createPullRequest"] = Effect.fn(
    "AdePublicationRepoPort.createPullRequest",
  )(function* (input) {
    yield* requireRef("createPullRequest", input.baseBranch);
    yield* requireRef("createPullRequest", input.bookmarkName);
    const result = yield* ghRun(
      "createPullRequest",
      input.repoPath,
      [
        "pr",
        "create",
        "--base",
        input.baseBranch,
        "--head",
        input.bookmarkName,
        "--title",
        input.title,
        "--body",
        input.body,
      ],
      ADE_PUBLICATION_GH_WRITE_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      return yield* new AdePublicationRepoError({
        operation: "createPullRequest",
        detail: trimOutput(`${result.stderr}\n${result.stdout}`.trim()),
      });
    }
    // The caller does not take the number from here. `gh pr create` is not
    // idempotent, and a crash between create and record would strand the PR;
    // the next pass adopts it by head branch instead (invariant 2).
  });

  const retargetPullRequest: AdePublicationRepoPortShape["retargetPullRequest"] = Effect.fn(
    "AdePublicationRepoPort.retargetPullRequest",
  )(function* (input) {
    const reference = yield* requirePrNumber("retargetPullRequest", input.prNumber);
    yield* requireRef("retargetPullRequest", input.baseBranch);
    const result = yield* ghRun("retargetPullRequest", input.repoPath, [
      "pr",
      "edit",
      reference,
      "--base",
      input.baseBranch,
    ]);
    if (result.exitCode !== 0) {
      return yield* new AdePublicationRepoError({
        operation: "retargetPullRequest",
        detail: trimOutput(`${result.stderr}\n${result.stdout}`.trim()),
      });
    }
  });

  const mergePullRequest: AdePublicationRepoPortShape["mergePullRequest"] = Effect.fn(
    "AdePublicationRepoPort.mergePullRequest",
  )(function* (input) {
    const reference = yield* requirePrNumber("mergePullRequest", input.prNumber);
    // Deliberately no `--delete-branch`: it cascade-closes every dependent PR
    // in the stack (spike P4). Cleanup is a separate pass.
    const result = yield* ghRun(
      "mergePullRequest",
      input.repoPath,
      ["pr", "merge", reference, `--${input.mergeMethod}`],
      ADE_PUBLICATION_GH_WRITE_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      return yield* new AdePublicationRepoError({
        operation: "mergePullRequest",
        detail: trimOutput(`${result.stderr}\n${result.stdout}`.trim()),
      });
    }
  });

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  const landedShas: AdePublicationRepoPortShape["landedShas"] = Effect.fn(
    "AdePublicationRepoPort.landedShas",
  )(function* (input) {
    yield* requireRef("landedShas", input.baseBookmark);
    yield* requireRef("landedShas", input.remote);
    const baseLiteral = remoteBookmarkRevset(input.baseBookmark, input.remote);
    const landed: Array<string> = [];
    for (const sha of input.shas) {
      yield* requireSha("landedShas", sha);
      const hit = yield* isAncestorOrEqual(input.repoPath, revsetLiteral(sha), baseLiteral);
      if (hit) landed.push(sha);
    }
    return landed;
  });

  const refreshStack: AdePublicationRepoPortShape["refreshStack"] = Effect.fn(
    "AdePublicationRepoPort.refreshStack",
  )(function* (input) {
    yield* requireChangeId("refreshStack", input.bottomChangeId);
    yield* requireRef("refreshStack", input.baseBookmark);
    yield* requireRef("refreshStack", input.remote);
    const bottomLiteral = revsetLiteral(input.bottomChangeId);

    // A change that no longer resolves is the *converged* state, not an error:
    // `--skip-emptied` abandoned it on an earlier pass because its content had
    // landed. Reporting a failure here would make a completed reconciliation
    // look like a broken one forever.
    const bottomSha = yield* readRevisionCommitId(input.repoPath, bottomLiteral);
    if (bottomSha === null) return { resolved: false, rebased: false, conflictDetail: null };

    const result = yield* jj("refreshStack", input.repoPath, [
      "rebase",
      "-s",
      bottomLiteral,
      "-d",
      remoteBookmarkRevset(input.baseBookmark, input.remote),
      "--skip-emptied",
    ]);
    const combined = `${result.stderr}\n${result.stdout}`.trim();
    if (result.exitCode !== 0) {
      if (MISSING_REVISION_MARKER.test(combined)) {
        return { resolved: false, rebased: false, conflictDetail: null };
      }
      if (NOOP_MARKER.test(combined)) {
        return { resolved: true, rebased: false, conflictDetail: null };
      }
      return {
        resolved: true,
        rebased: false,
        conflictDetail: trimOutput(combined || "refresh failed"),
      };
    }
    if (CONFLICT_MARKER.test(combined)) {
      return { resolved: true, rebased: false, conflictDetail: trimOutput(combined) };
    }
    return { resolved: true, rebased: !NOOP_MARKER.test(combined), conflictDetail: null };
  });

  const workingCopyFingerprint: AdePublicationRepoPortShape["workingCopyFingerprint"] = Effect.fn(
    "AdePublicationRepoPort.workingCopyFingerprint",
  )(function* (input) {
    const result = yield* jjOrFail("workingCopyFingerprint", input.repoPath, [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      'commit_id ++ " " ++ change_id ++ "\\n"',
    ]);
    const [commitId = "", changeId = ""] = (result.stdout.trim().split("\n")[0] ?? "").split(" ");
    if (commitId === "" || changeId === "") {
      return yield* new AdePublicationRepoError({
        operation: "workingCopyFingerprint",
        detail: "the working copy revision could not be read",
      });
    }
    return { commitId, changeId };
  });

  return AdePublicationRepoPort.of({
    fetch,
    readPullRequestsByHeadBranch,
    ensureBookmark,
    readBookmarkSha,
    pushBookmarks,
    deleteBookmarks,
    linkStack,
    readNativeStacks,
    markPullRequestsReady,
    mergeStack,
    createPullRequest,
    retargetPullRequest,
    mergePullRequest,
    landedShas,
    refreshStack,
    workingCopyFingerprint,
  });
});

export const layer: Layer.Layer<
  AdePublicationRepoPort,
  never,
  VcsDriver.VcsDriver | GitHubCli.GitHubCli
> = Layer.effect(AdePublicationRepoPort, make);
