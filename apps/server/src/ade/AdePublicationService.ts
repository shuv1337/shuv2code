// @effect-diagnostics nodeBuiltinImport:off
/**
 * ADE publication service (spec `docs/ade/ADE-V1-SPEC.md` §4.5, ADR §8, §14.5,
 * §16.3; spike [#134](https://github.com/shuv1337/shuv2code/issues/134) —
 * issue #165).
 *
 * One active publication stack per project turns integrated-but-unpublished
 * work into a stack of GitHub pull requests, merges it as a whole, and folds
 * the result back into JJ. Native GitHub Stacked PRs (`gh stack link` /
 * `gh stack merge`) are the primary path; plain chained PRs are the fallback,
 * and the two share every JJ-side mechanism (ADR §8.1).
 *
 * The design is one idea repeated: **there is no journal, only convergence.**
 * Nothing records "which step we reached". Each pass re-derives the whole
 * world from remote truth and does whatever that truth implies, which makes
 * first publish, no-op re-run, branch repair, PR replacement, base retargeting,
 * and post-merge reconciliation the same code path (ADR §16.3). Five invariants
 * carry it, each one a spike finding rather than a preference:
 *
 * 1. **Converge-then-act.** Every pass begins with `jj git fetch` and fresh
 *    `gh` reads. `jj git push` is idempotent only against jj's last-fetched
 *    view of the remote: after an out-of-band branch deletion it reports
 *    "already matches" and repairs nothing. Fetch is also what deletes the
 *    local bookmark for a vanished remote branch — and the durable `changeId`
 *    is what recreates it. No GitHub state is ever cached across passes.
 * 2. **`prNumber` is mutable, and adoption is by head branch.** Deleting a
 *    branch mid-stack cascade-closes dependents, and reopening only works while
 *    the head sits at the same SHA; past that the repair mints a *replacement*
 *    PR. So the layer's PR is whatever GitHub currently shows for its head
 *    branch, and the record follows GitHub rather than the other way round.
 * 3. **Post-merge logic keys on recorded SHAs.** A merged layer's change id
 *    stops resolving once `--skip-emptied` abandons it, and branch names are
 *    deleted and reused out of band. The recorded merge SHA is the only key
 *    that survives, so landing is detected by ancestry over SHAs.
 * 4. **Zero writes inside operated workspaces.** jj snapshots the working copy
 *    on every command and folds stray files into `@`. The port suppresses that
 *    snapshot entirely; this service additionally fingerprints `@` around every
 *    pass so a regression is loud rather than silent.
 * 5. **Never `--delete-branch`; cleanup is explicit.** Branch removal happens
 *    only in `cleanupStack`, after reconciliation, because deleting a
 *    publication branch at any other moment destroys dependent PRs.
 *
 * The service is backend-only. S12 renders the stack panel from `getStack`;
 * `adoptIntegratedCandidates` is how a stack reacts to the integration service
 * landing new candidates — by polling durable rows rather than by subscribing
 * to an event, so a missed notification cannot desynchronize anything.
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type AdeProjectId,
  type IntegrationCandidateId,
  JJ_CHANGE_ID_PATTERN,
  type PublicationLayer,
  type PublicationLayerId,
  type PublicationLayerStatus,
  type PublicationStack,
  type PublicationStackId,
  type PublicationStackMode,
  type PublicationStackStatus,
} from "@shuv2code/contracts";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { forkParked } from "../serverActivation.ts";
import {
  AdePublicationRepoError,
  AdePublicationRepoPort,
  type PublicationPrState,
  type PublishedPullRequest,
  refValidationDetail,
} from "./AdePublicationRepoPort.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AdePublicationProjectNotFoundError extends Schema.TaggedErrorClass<AdePublicationProjectNotFoundError>()(
  "AdePublicationProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `ADE project ${this.projectId} does not exist`;
  }
}

/**
 * Publication needs somewhere to publish *to*. A repo-bound project with no
 * remote can still integrate (ADR §14.2) but cannot open a pull request, so the
 * refusal is explicit rather than a confusing failure deep inside `gh`.
 */
export class AdePublicationProjectNotPublishableError extends Schema.TaggedErrorClass<AdePublicationProjectNotPublishableError>()(
  "AdePublicationProjectNotPublishableError",
  { projectId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `ADE project ${this.projectId} cannot publish: ${this.detail}`;
  }
}

export class AdePublicationStackNotFoundError extends Schema.TaggedErrorClass<AdePublicationStackNotFoundError>()(
  "AdePublicationStackNotFoundError",
  { stackId: Schema.String },
) {
  override get message(): string {
    return `ADE publication stack ${this.stackId} does not exist`;
  }
}

export class AdePublicationStackStateError extends Schema.TaggedErrorClass<AdePublicationStackStateError>()(
  "AdePublicationStackStateError",
  { stackId: Schema.String, expected: Schema.String, actual: Schema.String },
) {
  override get message(): string {
    return `ADE publication stack ${this.stackId} is ${this.actual}, expected ${this.expected}`;
  }
}

// A contended pass is not an error: `processStack` reports `busy` and the next
// sweep picks the stack up. Publication talks to GitHub, so two overlapping
// passes would create duplicate PRs — the lease, not an exception, is what
// prevents that.

/**
 * The pass detected that it had written into the workspace it operates on
 * (spec §4.5 invariant 4) — or could not prove that it had not. This is the one
 * invariant whose violation silently corrupts someone else's work, so it is a
 * hard failure rather than a warning.
 */
export class AdePublicationInvariantError extends Schema.TaggedErrorClass<AdePublicationInvariantError>()(
  "AdePublicationInvariantError",
  { stackId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `ADE publication stack ${this.stackId} violated the no-writes invariant: ${this.detail}`;
  }
}

export class AdePublicationLayerInvalidError extends Schema.TaggedErrorClass<AdePublicationLayerInvalidError>()(
  "AdePublicationLayerInvalidError",
  { stackId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `ADE publication layer rejected for stack ${this.stackId}: ${this.detail}`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OpenStackInput {
  readonly projectId: AdeProjectId;
  readonly mode?: PublicationStackMode;
  /** The branch the bottom layer targets; defaults to the canonical bookmark. */
  readonly baseBookmark?: string;
}

export interface OpenStackOutcome {
  readonly stack: PublicationStack;
  /** False when an active stack already existed — opening is idempotent. */
  readonly created: boolean;
}

export interface AppendLayerInput {
  readonly stackId: PublicationStackId;
  readonly changeIds: ReadonlyArray<string>;
  /** Defaults to a deterministic `ade/pub/<stack>/<order>` name. */
  readonly bookmarkName?: string;
  readonly integrationCandidateId?: IntegrationCandidateId;
}

export interface StackView {
  readonly stack: PublicationStack;
  readonly layers: ReadonlyArray<PublicationLayer>;
}

export type ProcessStackOutcome =
  /** Nothing to do: the stack is settled, or has no layers yet. */
  | { readonly _tag: "idle"; readonly stackId: PublicationStackId }
  /** Someone else holds the pass. */
  | { readonly _tag: "busy"; readonly stackId: PublicationStackId }
  | {
      readonly _tag: "advanced";
      readonly stackId: PublicationStackId;
      readonly status: PublicationStackStatus;
    }
  /** A mechanical failure; the stack keeps its state and the next pass re-runs. */
  | { readonly _tag: "deferred"; readonly stackId: PublicationStackId; readonly detail: string }
  /** A refresh conflicted. Never forced — a human untangles it. */
  | { readonly _tag: "blocked"; readonly stackId: PublicationStackId; readonly detail: string };

export interface AdoptOutcome {
  readonly appended: ReadonlyArray<PublicationLayerId>;
}

export interface CleanupOutcome {
  readonly deletedBookmarks: ReadonlyArray<string>;
}

export interface AdePublicationServiceShape {
  /** Idempotent: one active stack per project (ADR §8.3). */
  readonly openStack: (
    input: OpenStackInput,
  ) => Effect.Effect<
    OpenStackOutcome,
    | AdePublicationProjectNotFoundError
    | AdePublicationProjectNotPublishableError
    | PersistenceSqlError
  >;

  readonly appendLayer: (
    input: AppendLayerInput,
  ) => Effect.Effect<
    PublicationLayer,
    AdePublicationStackNotFoundError | AdePublicationLayerInvalidError | PersistenceSqlError
  >;

  /**
   * Append a layer for every integrated candidate the active stack has not
   * represented yet. This is how publication reacts to integration: by reading
   * durable rows, so a dropped in-process event cannot desynchronize the stack.
   */
  readonly adoptIntegratedCandidates: (
    projectId: AdeProjectId,
  ) => Effect.Effect<AdoptOutcome, PersistenceSqlError>;

  /**
   * Reorder while the stack is still `building`. Stack order freezes when
   * review begins (ADR §8.3), so this refuses a frozen stack.
   */
  readonly reorderLayers: (input: {
    readonly stackId: PublicationStackId;
    readonly layerIdsInOrder: ReadonlyArray<PublicationLayerId>;
  }) => Effect.Effect<
    StackView,
    | AdePublicationStackNotFoundError
    | AdePublicationStackStateError
    | AdePublicationLayerInvalidError
    | PersistenceSqlError
  >;

  readonly getStack: (
    stackId: PublicationStackId,
  ) => Effect.Effect<StackView | null, PersistenceSqlError>;

  /** The active stack for a project, if any — what S12's panel renders. */
  readonly getActiveStack: (
    projectId: AdeProjectId,
  ) => Effect.Effect<StackView | null, PersistenceSqlError>;

  /** Freeze order and open review (`building → review-frozen`). */
  readonly freezeStack: (
    stackId: PublicationStackId,
  ) => Effect.Effect<
    StackView,
    AdePublicationStackNotFoundError | AdePublicationStackStateError | PersistenceSqlError
  >;

  /** Request the whole-stack merge (`building | review-frozen → merging`). */
  readonly requestMerge: (
    stackId: PublicationStackId,
  ) => Effect.Effect<
    StackView,
    AdePublicationStackNotFoundError | AdePublicationStackStateError | PersistenceSqlError
  >;

  /** One converge-then-act pass. Safe to call at any time, from any state. */
  readonly processStack: (
    stackId: PublicationStackId,
  ) => Effect.Effect<ProcessStackOutcome, AdePublicationStackNotFoundError | PersistenceSqlError>;

  readonly runOnce: () => Effect.Effect<
    { readonly stacks: ReadonlyArray<PublicationStackId> },
    PersistenceSqlError
  >;

  /** The explicit post-reconcile cleanup pass (invariant 5). */
  readonly cleanupStack: (
    stackId: PublicationStackId,
  ) => Effect.Effect<
    CleanupOutcome,
    AdePublicationStackNotFoundError | AdePublicationStackStateError | PersistenceSqlError
  >;

  /** Restart recovery: release expired leases so the next pass re-converges. */
  readonly recoverStacks: () => Effect.Effect<
    { readonly released: ReadonlyArray<PublicationStackId> },
    PersistenceSqlError
  >;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface StackRow {
  readonly publication_stack_id: string;
  readonly project_id: string;
  readonly mode: string;
  readonly status: string;
  readonly stack_url: string | null;
  readonly native_stack_number: number | null;
  readonly native_stack_node_id: string | null;
  readonly base_bookmark: string;
  readonly lease_holder: string | null;
  readonly lease_expires_at: string | null;
  readonly cleaned_up_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface LayerRow {
  readonly publication_layer_id: string;
  readonly publication_stack_id: string;
  readonly layer_order: number;
  readonly change_ids_json: string;
  readonly bookmark_name: string;
  readonly pr_number: number | null;
  readonly head_sha: string | null;
  readonly submitted_sha: string | null;
  readonly merge_sha: string | null;
  readonly pr_state: string | null;
  readonly status: string;
  readonly integration_candidate_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PublishableProject {
  readonly projectId: AdeProjectId;
  readonly repoPath: string;
  readonly repoRemote: string;
}

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeStringArray = Schema.decodeUnknownEffect(StringArrayJson);
const encodeStringArray = Schema.encodeEffect(StringArrayJson);

const rowToStack = (row: StackRow): PublicationStack =>
  ({
    id: row.publication_stack_id as PublicationStackId,
    projectId: row.project_id as AdeProjectId,
    mode: row.mode as PublicationStackMode,
    status: row.status as PublicationStackStatus,
    stackUrl: row.stack_url,
    nativeStackNumber: row.native_stack_number,
    nativeStackNodeId: row.native_stack_node_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as PublicationStack;

const rowToLayer = Effect.fn("AdePublicationService.rowToLayer")(function* (row: LayerRow) {
  const changeIds = yield* decodeStringArray(row.change_ids_json);
  return {
    id: row.publication_layer_id as PublicationLayerId,
    stackId: row.publication_stack_id as PublicationStackId,
    order: row.layer_order,
    changeIds,
    bookmarkName: row.bookmark_name,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    submittedSha: row.submitted_sha,
    mergeSha: row.merge_sha,
    prState: row.pr_state as PublicationPrState | null,
    status: row.status as PublicationLayerStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as PublicationLayer;
}, Effect.orDie);

/**
 * SQLite has no deferrable unique constraints and migration 055 puts a unique
 * index on `(stack, layer_order)`, so a reorder cannot exchange two orders in
 * place. Every row is first parked above any real order, then written down to
 * its final position.
 */
const REORDER_OFFSET = 1_000_000;

const ACTIVE_STATUSES = ["building", "review-frozen", "merging"] as const;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const make = (options: AdePublicationServiceOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* AdePublicationRepoPort;

    const leaseTtl = options.leaseTtl ?? ADE_PUBLICATION_LEASE_TTL_DEFAULT;
    const defaultBaseBookmark = options.defaultBaseBookmark ?? "main";
    const mergeMethod = options.mergeMethod ?? "squash";
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const leaseExpiryIso = Effect.map(DateTime.now, (now) =>
      DateTime.formatIso(DateTime.addDuration(now, leaseTtl)),
    );
    const uuid = Effect.sync(() => NodeCrypto.randomUUID());
    const mapSql = (operation: string) =>
      toPersistenceSqlError(`AdePublicationService.${operation}`);

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------

    const readStackRow = (stackId: string) =>
      sql<StackRow>`
        SELECT * FROM ade_publication_stacks WHERE publication_stack_id = ${stackId}
      `;

    const requireStackRow = Effect.fn("AdePublicationService.requireStackRow")(function* (
      stackId: PublicationStackId,
    ) {
      const rows = yield* readStackRow(stackId).pipe(Effect.mapError(mapSql("requireStackRow")));
      const row = rows[0];
      if (row === undefined) return yield* new AdePublicationStackNotFoundError({ stackId });
      return row;
    });

    const readLayerRows = (stackId: string) =>
      sql<LayerRow>`
        SELECT * FROM ade_publication_layers
        WHERE publication_stack_id = ${stackId}
        ORDER BY layer_order ASC
      `;

    const viewOf = Effect.fn("AdePublicationService.viewOf")(function* (row: StackRow) {
      const layers = yield* readLayerRows(row.publication_stack_id).pipe(
        Effect.mapError(mapSql("viewOf")),
      );
      return {
        stack: rowToStack(row),
        layers: yield* Effect.forEach(layers, rowToLayer),
      } satisfies StackView;
    });

    const requirePublishableProject = Effect.fn("AdePublicationService.requirePublishableProject")(
      function* (projectId: AdeProjectId) {
        const rows = yield* sql<{
          readonly project_id: string;
          readonly repo_path: string | null;
          readonly repo_remote: string | null;
        }>`
        SELECT project_id, repo_path, repo_remote FROM ade_projects
        WHERE project_id = ${projectId}
      `.pipe(Effect.mapError(mapSql("requirePublishableProject")));
        const row = rows[0];
        if (row === undefined) return yield* new AdePublicationProjectNotFoundError({ projectId });
        if (row.repo_path === null) {
          return yield* new AdePublicationProjectNotPublishableError({
            projectId,
            detail: "the project has no repository binding",
          });
        }
        if (row.repo_remote === null) {
          return yield* new AdePublicationProjectNotPublishableError({
            projectId,
            detail: "the project's repository has no remote to publish to",
          });
        }
        return {
          projectId,
          repoPath: row.repo_path,
          repoRemote: row.repo_remote,
        } satisfies PublishableProject;
      },
    );

    const getStack: AdePublicationServiceShape["getStack"] = Effect.fn(
      "AdePublicationService.getStack",
    )(function* (stackId: PublicationStackId) {
      const rows = yield* readStackRow(stackId).pipe(Effect.mapError(mapSql("getStack")));
      const row = rows[0];
      return row === undefined ? null : yield* viewOf(row);
    });

    const readActiveStackRow = (projectId: string) =>
      sql<StackRow>`
        SELECT * FROM ade_publication_stacks
        WHERE project_id = ${projectId}
          AND status IN ('building', 'review-frozen', 'merging')
        ORDER BY created_at ASC, rowid ASC
        LIMIT 1
      `;

    const getActiveStack: AdePublicationServiceShape["getActiveStack"] = Effect.fn(
      "AdePublicationService.getActiveStack",
    )(function* (projectId: AdeProjectId) {
      const rows = yield* readActiveStackRow(projectId).pipe(
        Effect.mapError(mapSql("getActiveStack")),
      );
      const row = rows[0];
      return row === undefined ? null : yield* viewOf(row);
    });

    // -----------------------------------------------------------------------
    // Lease
    // -----------------------------------------------------------------------
    //
    // *Every* mutation of a stack runs under its lease, not just the pass. The
    // sharp race is an adoption landing between the pass deciding "everything
    // has landed" and it writing `reconciled`: the new layer would be stranded
    // on a settled stack that nothing will ever publish. Making the lease cover
    // the whole mutating surface removes that window by construction rather
    // than by re-checking for it.

    const claimStack = Effect.fn("AdePublicationService.claimStack")(function* (
      stackId: string,
      holder: string,
    ) {
      const at = yield* nowIso;
      const expiresAt = yield* leaseExpiryIso;
      const rows = yield* sql<StackRow>`
        UPDATE ade_publication_stacks
        SET lease_holder = ${holder}, lease_expires_at = ${expiresAt}, updated_at = ${at}
        WHERE publication_stack_id = ${stackId}
          AND (lease_holder IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ${at})
        RETURNING *
      `.pipe(Effect.mapError(mapSql("claimStack")));
      return rows[0] ?? null;
    });

    const releaseStack = Effect.fn("AdePublicationService.releaseStack")(function* (
      stackId: string,
      holder: string,
    ) {
      const at = yield* nowIso;
      yield* sql`
        UPDATE ade_publication_stacks
        SET lease_holder = NULL, lease_expires_at = NULL, updated_at = ${at}
        WHERE publication_stack_id = ${stackId} AND lease_holder = ${holder}
      `.pipe(Effect.mapError(mapSql("releaseStack")));
    });

    /**
     * Run `body` holding the stack's lease, or return `onBusy()` when another
     * worker has it. The lease is always released, including on interruption.
     */
    const withStackLease = <A, E, R>(
      stackId: string,
      body: (claimed: StackRow) => Effect.Effect<A, E, R>,
      onBusy: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | PersistenceSqlError, R> =>
      Effect.gen(function* () {
        const holder = yield* uuid;
        const claimed = yield* claimStack(stackId, holder);
        if (claimed === null) return yield* onBusy;
        return yield* body(claimed).pipe(
          Effect.ensuring(releaseStack(stackId, holder).pipe(Effect.orDie)),
        );
      });

    // -----------------------------------------------------------------------
    // Stack lifecycle
    // -----------------------------------------------------------------------

    const openStack: AdePublicationServiceShape["openStack"] = Effect.fn(
      "AdePublicationService.openStack",
    )(function* (input: OpenStackInput) {
      yield* requirePublishableProject(input.projectId);
      const baseBookmark = input.baseBookmark ?? defaultBaseBookmark;
      const baseDetail = refValidationDetail(baseBookmark);
      if (baseDetail !== null) {
        return yield* new AdePublicationProjectNotPublishableError({
          projectId: input.projectId,
          detail: baseDetail,
        });
      }

      const existing = yield* readActiveStackRow(input.projectId).pipe(
        Effect.mapError(mapSql("openStack.existing")),
      );
      const active = existing[0];
      if (active !== undefined) return { stack: rowToStack(active), created: false };

      const stackId = yield* uuid;
      const at = yield* nowIso;
      const inserted = yield* sql<StackRow>`
        INSERT INTO ade_publication_stacks (
          publication_stack_id, project_id, mode, status, stack_url,
          native_stack_number, native_stack_node_id, base_bookmark,
          lease_holder, lease_expires_at, created_at, updated_at
        ) VALUES (
          ${stackId}, ${input.projectId}, ${input.mode ?? "native-stack"}, 'building', NULL,
          NULL, NULL, ${baseBookmark},
          NULL, NULL, ${at}, ${at}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `.pipe(Effect.mapError(mapSql("openStack.insert")));
      const row = inserted[0];
      if (row !== undefined) return { stack: rowToStack(row), created: true };

      // Lost the race against the one-active-stack partial index: re-read.
      const raced = yield* readActiveStackRow(input.projectId).pipe(
        Effect.mapError(mapSql("openStack.raced")),
      );
      const racedRow = raced[0];
      if (racedRow === undefined) {
        return yield* Effect.die(
          new Error("publication stack insert reported an impossible conflict"),
        );
      }
      return { stack: rowToStack(racedRow), created: false };
    });

    const transitionStack = Effect.fn("AdePublicationService.transitionStack")(function* (input: {
      readonly stackId: PublicationStackId;
      readonly from: ReadonlyArray<PublicationStackStatus>;
      readonly to: PublicationStackStatus;
    }) {
      const row = yield* requireStackRow(input.stackId);
      const status = row.status as PublicationStackStatus;
      if (status === input.to) return yield* viewOf(row);
      if (!input.from.includes(status)) {
        return yield* new AdePublicationStackStateError({
          stackId: input.stackId,
          expected: input.from.join(" | "),
          actual: status,
        });
      }
      const at = yield* nowIso;
      const updated = yield* sql<StackRow>`
        UPDATE ade_publication_stacks
        SET status = ${input.to}, updated_at = ${at}
        WHERE publication_stack_id = ${input.stackId}
        RETURNING *
      `.pipe(Effect.mapError(mapSql("transitionStack")));
      const next = updated[0];
      if (next === undefined) {
        return yield* new AdePublicationStackNotFoundError({ stackId: input.stackId });
      }
      return yield* viewOf(next);
    });

    /** A status change is a mutation, so it waits for the pass to finish. */
    const leasedTransition = (
      stackId: PublicationStackId,
      from: ReadonlyArray<PublicationStackStatus>,
      to: PublicationStackStatus,
    ) =>
      withStackLease(
        stackId,
        () => transitionStack({ stackId, from, to }),
        Effect.gen(function* () {
          const row = yield* requireStackRow(stackId);
          return yield* new AdePublicationStackStateError({
            stackId,
            expected: `${from.join(" | ")} (not held by another worker)`,
            actual: `${row.status}, leased`,
          });
        }),
      );

    const freezeStack: AdePublicationServiceShape["freezeStack"] = (stackId) =>
      leasedTransition(stackId, ["building"], "review-frozen");

    const requestMerge: AdePublicationServiceShape["requestMerge"] = (stackId) =>
      leasedTransition(stackId, ["building", "review-frozen"], "merging");

    // -----------------------------------------------------------------------
    // Layers
    // -----------------------------------------------------------------------

    /**
     * Deterministic and safe by construction: a UUID's hex digits and a padded
     * order index cannot express a glob, a path traversal, or a flag. Callers
     * may still supply their own name, which is validated the same way.
     */
    const defaultBookmarkFor = (stackId: string, order: number) =>
      `ade/pub/${stackId.replaceAll("-", "").slice(0, 12)}/${String(order).padStart(4, "0")}`;

    /**
     * Append without taking the lease — for callers that already hold it.
     * `appendLayer` is the public, leased entry point.
     */
    const appendLayerUnlocked = Effect.fn("AdePublicationService.appendLayerUnlocked")(function* (
      input: AppendLayerInput,
    ) {
      const stackRow = yield* requireStackRow(input.stackId);
      if (input.changeIds.length === 0) {
        return yield* new AdePublicationLayerInvalidError({
          stackId: input.stackId,
          detail: "a layer must carry at least one change id",
        });
      }
      // Second defense behind the contracts-level `JjChangeId` pattern: nothing
      // reaches `jj` unquoted, and a change id that is really a revset or a flag
      // is refused before it is ever persisted.
      for (const changeId of input.changeIds) {
        if (!JJ_CHANGE_ID_PATTERN.test(changeId)) {
          return yield* new AdePublicationLayerInvalidError({
            stackId: input.stackId,
            detail: `'${changeId}' is not a plain JJ change id`,
          });
        }
      }

      const existingLayers = yield* readLayerRows(input.stackId).pipe(
        Effect.mapError(mapSql("appendLayer.read")),
      );
      // Adoption idempotency: a re-running pass must not append a second layer
      // for a candidate it already published.
      if (input.integrationCandidateId !== undefined) {
        const already = existingLayers.find(
          (layer) => layer.integration_candidate_id === input.integrationCandidateId,
        );
        if (already !== undefined) return yield* rowToLayer(already);
      }
      const order = existingLayers.reduce((max, layer) => Math.max(max, layer.layer_order + 1), 0);
      const bookmarkName = input.bookmarkName ?? defaultBookmarkFor(input.stackId, order);
      const bookmarkDetail = refValidationDetail(bookmarkName);
      if (bookmarkDetail !== null) {
        return yield* new AdePublicationLayerInvalidError({
          stackId: input.stackId,
          detail: bookmarkDetail,
        });
      }

      // Branch names are the key adoption looks work up by, so reusing one that
      // an earlier, not-yet-cleaned-up stack still owns is how a fresh layer
      // ends up adopting its ancestor's *merged* PR — and then never publishing
      // at all. A stack owns its names until cleanup has actually removed them.
      const reused = yield* sql<{ readonly publication_stack_id: string }>`
        SELECT l.publication_stack_id FROM ade_publication_layers l
        JOIN ade_publication_stacks s
          ON s.publication_stack_id = l.publication_stack_id
        WHERE s.project_id = ${stackRow.project_id}
          AND s.cleaned_up_at IS NULL
          AND l.bookmark_name = ${bookmarkName}
          AND l.publication_stack_id != ${input.stackId}
        LIMIT 1
      `.pipe(Effect.mapError(mapSql("appendLayer.reuse")));
      const owner = reused[0];
      if (owner !== undefined) {
        return yield* new AdePublicationLayerInvalidError({
          stackId: input.stackId,
          detail: `branch '${bookmarkName}' is still owned by stack ${owner.publication_stack_id}; clean that stack up before reusing the name`,
        });
      }

      const layerId = yield* uuid;
      const at = yield* nowIso;
      const changesJson = yield* Effect.orDie(encodeStringArray([...input.changeIds]));
      const inserted = yield* sql<LayerRow>`
        INSERT INTO ade_publication_layers (
          publication_layer_id, publication_stack_id, layer_order, change_ids_json,
          bookmark_name, pr_number, head_sha, submitted_sha, merge_sha, pr_state,
          status, integration_candidate_id, created_at, updated_at
        ) VALUES (
          ${layerId}, ${stackRow.publication_stack_id}, ${order}, ${changesJson},
          ${bookmarkName}, NULL, NULL, NULL, NULL, NULL,
          'pending', ${input.integrationCandidateId ?? null}, ${at}, ${at}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `.pipe(Effect.mapError(mapSql("appendLayer.insert")));
      const row = inserted[0];
      if (row !== undefined) return yield* rowToLayer(row);

      // A unique index refused us — another worker appended concurrently. When
      // this append is an adoption, the *candidate id* is the identity that
      // matters: matching on the branch name alone would hand back whatever row
      // happens to hold that name, which after a name collision is a different
      // candidate's layer entirely.
      const raced = yield* readLayerRows(input.stackId).pipe(
        Effect.mapError(mapSql("appendLayer.raced")),
      );
      const racedRow =
        input.integrationCandidateId !== undefined
          ? raced.find((layer) => layer.integration_candidate_id === input.integrationCandidateId)
          : raced.find((layer) => layer.bookmark_name === bookmarkName);
      if (racedRow === undefined) {
        return yield* new AdePublicationLayerInvalidError({
          stackId: input.stackId,
          detail: `layer order ${order} or bookmark '${bookmarkName}' is already taken`,
        });
      }
      return yield* rowToLayer(racedRow);
    });

    const appendLayer: AdePublicationServiceShape["appendLayer"] = (input) =>
      withStackLease(
        input.stackId,
        () => appendLayerUnlocked(input),
        Effect.gen(function* () {
          yield* requireStackRow(input.stackId);
          return yield* new AdePublicationLayerInvalidError({
            stackId: input.stackId,
            detail: "the stack is being processed by another worker; retry once the pass finishes",
          });
        }),
      );

    const adoptIntegratedCandidates: AdePublicationServiceShape["adoptIntegratedCandidates"] =
      Effect.fn("AdePublicationService.adoptIntegratedCandidates")(function* (
        projectId: AdeProjectId,
      ) {
        const activeRows = yield* readActiveStackRow(projectId).pipe(
          Effect.mapError(mapSql("adoptIntegratedCandidates.stack")),
        );
        const activeRow = activeRows[0];
        // No active stack is a legitimate state: the captain has not opened one
        // yet, and integrated work simply accumulates as unpublished tail.
        if (activeRow === undefined) return { appended: [] };

        // Adoption mutates the stack, so it waits for any pass in flight. This
        // is the fix for the race where a layer lands between the pass deciding
        // "everything has landed" and it writing `reconciled` — the new layer
        // would sit on a settled stack forever.
        return yield* withStackLease(
          activeRow.publication_stack_id,
          (stackRow) => adoptUnderLease(stackRow),
          Effect.succeed({ appended: [] as ReadonlyArray<PublicationLayerId> }),
        );
      });

    const adoptUnderLease = Effect.fn("AdePublicationService.adoptUnderLease")(function* (
      stackRow: StackRow,
    ) {
      const projectId = stackRow.project_id as AdeProjectId;
      // A frozen stack still accepts appends *to the top* (ADR §8.3); a stack
      // that is already merging does not, because its contents are in flight.
      if (stackRow.status !== "building" && stackRow.status !== "review-frozen") {
        return { appended: [] as ReadonlyArray<PublicationLayerId> };
      }

      const candidates = yield* sql<{
        readonly integration_candidate_id: string;
        readonly change_ids_json: string;
      }>`
          SELECT c.integration_candidate_id, c.change_ids_json
          FROM ade_integration_candidates c
          WHERE c.project_id = ${projectId}
            AND c.status = 'integrated'
            AND NOT EXISTS (
              SELECT 1 FROM ade_publication_layers l
              WHERE l.publication_stack_id = ${stackRow.publication_stack_id}
                AND l.integration_candidate_id = c.integration_candidate_id
            )
          ORDER BY c.updated_at ASC, c.rowid ASC
        `.pipe(Effect.mapError(mapSql("adoptIntegratedCandidates.candidates")));

      const appended: Array<PublicationLayerId> = [];
      for (const candidate of candidates) {
        const changeIds = yield* Effect.orDie(decodeStringArray(candidate.change_ids_json));
        const layer = yield* appendLayerUnlocked({
          stackId: stackRow.publication_stack_id as PublicationStackId,
          changeIds,
          integrationCandidateId:
            candidate.integration_candidate_id as unknown as IntegrationCandidateId,
        }).pipe(
          Effect.catchTags({
            AdePublicationStackNotFoundError: () => Effect.succeed(null),
            AdePublicationLayerInvalidError: (error) =>
              Effect.as(
                Effect.logWarning("ADE publication skipped an unrepresentable candidate", {
                  candidateId: candidate.integration_candidate_id,
                  detail: error.detail,
                }),
                null,
              ),
          }),
        );
        if (layer !== null) appended.push(layer.id);
      }
      if (appended.length > 0) {
        yield* Effect.log("ADE publication adopted integrated candidates", {
          stackId: stackRow.publication_stack_id,
          appended,
        });
      }
      return { appended };
    });

    const reorderLayersUnlocked = Effect.fn("AdePublicationService.reorderLayersUnlocked")(
      function* (input: {
        readonly stackId: PublicationStackId;
        readonly layerIdsInOrder: ReadonlyArray<PublicationLayerId>;
      }) {
        const stackRow = yield* requireStackRow(input.stackId);
        if (stackRow.status !== "building") {
          return yield* new AdePublicationStackStateError({
            stackId: input.stackId,
            expected: "building",
            actual: stackRow.status,
          });
        }
        const current = yield* readLayerRows(input.stackId).pipe(
          Effect.mapError(mapSql("reorderLayers.read")),
        );
        const currentIds = current.map((layer) => layer.publication_layer_id);
        const requested = [...input.layerIdsInOrder];
        if (
          requested.length !== currentIds.length ||
          new Set(requested).size !== requested.length ||
          !requested.every((id) => currentIds.includes(id))
        ) {
          return yield* new AdePublicationLayerInvalidError({
            stackId: input.stackId,
            detail: "a reorder must list every layer of the stack exactly once",
          });
        }

        const at = yield* nowIso;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // Park every row above any real order first. Without the offset the
              // unique `(stack, layer_order)` index rejects the very first swap.
              yield* sql`
              UPDATE ade_publication_layers
              SET layer_order = layer_order + ${REORDER_OFFSET}
              WHERE publication_stack_id = ${input.stackId}
            `;
              for (const [index, layerId] of requested.entries()) {
                yield* sql`
                UPDATE ade_publication_layers
                SET layer_order = ${index}, updated_at = ${at}
                WHERE publication_layer_id = ${layerId}
                  AND publication_stack_id = ${input.stackId}
              `;
              }
            }),
          )
          .pipe(Effect.mapError(mapSql("reorderLayers.apply")));
        return yield* viewOf(stackRow);
      },
    );

    const reorderLayers: AdePublicationServiceShape["reorderLayers"] = (input) =>
      withStackLease(
        input.stackId,
        () => reorderLayersUnlocked(input),
        Effect.gen(function* () {
          const row = yield* requireStackRow(input.stackId);
          // Reordering while a pass is mid-publish would push branches in an
          // order the record no longer describes.
          return yield* new AdePublicationStackStateError({
            stackId: input.stackId,
            expected: "building (not held by another worker)",
            actual: `${row.status}, leased`,
          });
        }),
      );

    // -----------------------------------------------------------------------
    // Layer persistence used by the pass
    // -----------------------------------------------------------------------

    const updateLayer = Effect.fn("AdePublicationService.updateLayer")(function* (input: {
      readonly layerId: string;
      readonly prNumber?: number | null;
      readonly prState?: PublicationPrState | null;
      readonly headSha?: string | null;
      readonly submittedSha?: string | null;
      readonly mergeSha?: string | null;
      readonly status?: PublicationLayerStatus;
    }) {
      const at = yield* nowIso;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<LayerRow>`
              SELECT * FROM ade_publication_layers WHERE publication_layer_id = ${input.layerId}
            `;
            const row = rows[0];
            if (row === undefined) return;
            yield* sql`
              UPDATE ade_publication_layers SET
                pr_number = ${input.prNumber === undefined ? row.pr_number : input.prNumber},
                pr_state = ${input.prState === undefined ? row.pr_state : input.prState},
                head_sha = ${input.headSha === undefined ? row.head_sha : input.headSha},
                submitted_sha = ${
                  input.submittedSha === undefined ? row.submitted_sha : input.submittedSha
                },
                merge_sha = ${input.mergeSha === undefined ? row.merge_sha : input.mergeSha},
                status = ${input.status ?? row.status},
                updated_at = ${at}
              WHERE publication_layer_id = ${input.layerId}
            `;
          }),
        )
        .pipe(Effect.mapError(mapSql("updateLayer")));
    });

    const setStackFields = Effect.fn("AdePublicationService.setStackFields")(function* (input: {
      readonly stackId: string;
      readonly status?: PublicationStackStatus;
      readonly stackUrl?: string | null;
      readonly nativeStackNumber?: number | null;
      readonly nativeStackNodeId?: string | null;
      readonly mode?: PublicationStackMode;
      readonly cleanedUpAt?: string;
    }) {
      const at = yield* nowIso;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* readStackRow(input.stackId);
            const row = rows[0];
            if (row === undefined) return;
            yield* sql`
              UPDATE ade_publication_stacks SET
                status = ${input.status ?? row.status},
                mode = ${input.mode ?? row.mode},
                cleaned_up_at = ${input.cleanedUpAt ?? row.cleaned_up_at},
                stack_url = ${input.stackUrl === undefined ? row.stack_url : input.stackUrl},
                native_stack_number = ${
                  input.nativeStackNumber === undefined
                    ? row.native_stack_number
                    : input.nativeStackNumber
                },
                native_stack_node_id = ${
                  input.nativeStackNodeId === undefined
                    ? row.native_stack_node_id
                    : input.nativeStackNodeId
                },
                updated_at = ${at}
              WHERE publication_stack_id = ${input.stackId}
            `;
          }),
        )
        .pipe(Effect.mapError(mapSql("setStackFields")));
    });

    // -----------------------------------------------------------------------
    // The pass
    // -----------------------------------------------------------------------

    /**
     * Converge the durable record onto fresh GitHub truth.
     *
     * Runs before anything is acted on, and writes what it learns *before* the
     * action it enables. That ordering is what makes a crash harmless: the next
     * pass reads a record that already matches GitHub instead of one that
     * describes an intention nobody carried out.
     */
    const convergeLayers = Effect.fn("AdePublicationService.convergeLayers")(function* (input: {
      readonly project: PublishableProject;
      readonly layers: ReadonlyArray<LayerRow>;
    }) {
      const bookmarkNames = input.layers.map((layer) => layer.bookmark_name);
      const pullRequests = yield* repo.readPullRequestsByHeadBranch({
        repoPath: input.project.repoPath,
        bookmarkNames,
      });

      for (const layer of input.layers) {
        const forBranch = pullRequests.filter((pr) => pr.headRefName === layer.bookmark_name);
        // A *terminal* PR only belongs to this layer if it closed over the SHA
        // this layer actually published. Branch names get reused across stack
        // generations, so adopting any merged PR that happens to sit on the name
        // makes a fresh layer inherit an ancestor's merge: `landedShas` then
        // confirms that ancient merge, the layer never publishes, and cleanup
        // deletes the branch with the work still unshipped. `submitted_sha` is
        // recorded by `publishRefs` for exactly this comparison.
        const submitted = layer.submitted_sha;
        const isOurs = (pr: PublishedPullRequest) =>
          submitted !== null && pr.headSha !== null && pr.headSha === submitted;

        const adopted =
          // Ours, and merged — the only merge SHA reconciliation may key on.
          forBranch.find((entry) => entry.state === "merged" && isOurs(entry)) ??
          // A live PR on our branch: our next push updates it, so its head need
          // not match yet. This is the reopen/replacement case.
          forBranch.find((entry) => entry.state === "open") ??
          // Ours, cascade-closed — real state worth recording so the repair
          // path can see it.
          forBranch.find((entry) => entry.state === "closed" && isOurs(entry));

        if (adopted === undefined) {
          // Nothing on this branch is ours. If the record still points at a PR
          // from a previous generation, drop it so the layer publishes fresh
          // rather than sitting on someone else's merged work. A layer already
          // proven merged is left alone: a flaky read must not un-land it.
          if (layer.pr_number !== null && layer.status !== "merged") {
            yield* Effect.logWarning("ADE publication released a stale pull-request binding", {
              layerId: layer.publication_layer_id,
              bookmarkName: layer.bookmark_name,
              previousPrNumber: layer.pr_number,
              submittedSha: submitted,
            });
            yield* updateLayer({
              layerId: layer.publication_layer_id,
              prNumber: null,
              prState: null,
              status: "pending",
            });
          }
          continue;
        }

        // Adopt-by-head-branch (invariant 2): the layer's PR is whatever GitHub
        // shows for its head branch right now. A replacement PR minted after a
        // failed reopen therefore rebinds here, with no special case and no
        // knowledge of the number the record used to hold.
        if (adopted.number !== layer.pr_number) {
          yield* Effect.log("ADE publication rebound a layer to a replacement PR", {
            layerId: layer.publication_layer_id,
            bookmarkName: layer.bookmark_name,
            previousPrNumber: layer.pr_number,
            prNumber: adopted.number,
          });
        }
        yield* updateLayer({
          layerId: layer.publication_layer_id,
          prNumber: adopted.number,
          prState: adopted.state,
          headSha: adopted.headSha,
          // Merged is *detected*, never assumed, and only the merge SHA moves
          // the layer to `merged`. A PR reported merged without one would leave
          // reconciliation with no key to work from.
          ...(adopted.mergeSha !== null
            ? { mergeSha: adopted.mergeSha, status: "merged" as const }
            : {}),
          ...(adopted.state === "open" && layer.status === "pending"
            ? { status: "submitted" as const }
            : {}),
        });
      }

      return yield* readLayerRows(input.layers[0]?.publication_stack_id ?? "").pipe(
        Effect.mapError(mapSql("convergeLayers.reread")),
      );
    });

    /**
     * Place and publish the refs for every unmerged layer. Pure ref work: the
     * bookmark is derived from the durable change id, which is what recreates
     * one that the fetch deleted because its remote branch had vanished.
     */
    const publishRefs = Effect.fn("AdePublicationService.publishRefs")(function* (input: {
      readonly project: PublishableProject;
      readonly layers: ReadonlyArray<LayerRow>;
    }) {
      const pushed: Array<string> = [];
      for (const layer of input.layers) {
        const changeIds = yield* Effect.orDie(decodeStringArray(layer.change_ids_json));
        const head = changeIds[changeIds.length - 1];
        if (head === undefined) continue;
        const placed = yield* repo.ensureBookmark({
          repoPath: input.project.repoPath,
          bookmarkName: layer.bookmark_name,
          changeId: head,
        });
        if (placed.recreated) {
          yield* Effect.log("ADE publication recreated a lost publication bookmark", {
            layerId: layer.publication_layer_id,
            bookmarkName: layer.bookmark_name,
            headSha: placed.headSha,
          });
        }
        // Record the SHA we are about to submit *before* pushing it. On the next
        // pass this is what distinguishes "the branch still matches, so a closed
        // PR can be reopened" from "the head moved, so a replacement is due".
        yield* updateLayer({
          layerId: layer.publication_layer_id,
          headSha: placed.headSha,
          submittedSha: placed.headSha,
        });
        pushed.push(layer.bookmark_name);
      }
      if (pushed.length > 0) {
        yield* repo.pushBookmarks({
          repoPath: input.project.repoPath,
          remote: input.project.repoRemote,
          bookmarkNames: pushed,
        });
      }
      return pushed;
    });

    /**
     * The base of a layer is computed every pass, never stored as truth: it is
     * the previous *unmerged* layer's branch, or the stack's base branch when
     * there is none. A merged layer's content is already on the base, so the
     * next layer must retarget onto it or it would merge into a stale branch.
     */
    const basesFor = (stackRow: StackRow, unmerged: ReadonlyArray<LayerRow>) => {
      const bases = new Map<string, string>();
      let base = stackRow.base_bookmark;
      for (const layer of unmerged) {
        bases.set(layer.publication_layer_id, base);
        base = layer.bookmark_name;
      }
      return bases;
    };

    const runPass = Effect.fn("AdePublicationService.runPass")(function* (input: {
      readonly stackRow: StackRow;
      readonly project: PublishableProject;
    }) {
      const { project, stackRow } = input;
      const stackId = stackRow.publication_stack_id as PublicationStackId;

      // 1. Converge-then-act: remote truth before any decision (invariant 1).
      //    `jj git push` is only idempotent relative to jj's last-fetched view,
      //    so an out-of-band branch deletion is invisible until this runs.
      yield* repo.fetch({ repoPath: project.repoPath, remote: project.repoRemote });

      const initialLayers = yield* readLayerRows(stackRow.publication_stack_id).pipe(
        Effect.mapError(mapSql("runPass.layers")),
      );
      if (initialLayers.length === 0) return { _tag: "idle", stackId } as const;

      // 2. Fresh `gh` reads, and adopt by head branch (invariant 2).
      const layers = yield* convergeLayers({ project, layers: initialLayers });

      // 3. SHA-keyed landing detection (invariant 3). Change ids stop resolving
      //    once a layer merges and branch names get reused, so ancestry over the
      //    recorded merge SHAs is the only durable way to ask "did this land?".
      const recordedMergeShas = layers
        .map((layer) => layer.merge_sha)
        .filter((sha): sha is string => sha !== null);
      const landed = new Set(
        recordedMergeShas.length === 0
          ? []
          : yield* repo.landedShas({
              repoPath: project.repoPath,
              baseBookmark: stackRow.base_bookmark,
              remote: project.repoRemote,
              shas: recordedMergeShas,
            }),
      );

      const unmerged = layers.filter(
        (layer) => layer.merge_sha === null || !landed.has(layer.merge_sha),
      );
      const allLanded = unmerged.length === 0;

      // 4. Reconcile whenever *anything* has landed — not only when everything
      //    has. A partially merged stack (bottom squash-merged, top still open)
      //    otherwise keeps re-pushing a tail rooted in pre-squash commits, so
      //    the surviving PR shows the landed diff again forever. The rebase is
      //    the same `--skip-emptied` operation in both cases: it proves the
      //    landed layers empty, abandons them, and carries the tail onto the
      //    base. It runs *before* refs are published so the push carries the
      //    rebased commits.
      if (landed.size > 0) {
        // Start from the bottom-most layer that still resolves: on a later pass
        // the original bottom has already been abandoned by `--skip-emptied`,
        // and the surviving tail becomes the new starting point.
        const bottomCandidates: Array<string> = [];
        for (const layer of [layers[0], unmerged[0]]) {
          if (layer === undefined) continue;
          const changeIds = yield* Effect.orDie(decodeStringArray(layer.change_ids_json));
          const bottom = changeIds[0];
          if (bottom !== undefined && !bottomCandidates.includes(bottom)) {
            bottomCandidates.push(bottom);
          }
        }
        for (const bottomChangeId of bottomCandidates) {
          const refreshed = yield* repo.refreshStack({
            repoPath: project.repoPath,
            bottomChangeId,
            baseBookmark: stackRow.base_bookmark,
            remote: project.repoRemote,
          });
          if (refreshed.conflictDetail !== null) {
            // Never force a reconciliation past a conflict: that is how a
            // resolved-elsewhere merge silently reverts. Park it for a human,
            // and do not publish a conflicted tail.
            if (allLanded) yield* setStackFields({ stackId, status: "merged" });
            return { _tag: "blocked", stackId, detail: refreshed.conflictDetail } as const;
          }
          if (refreshed.resolved) break;
        }
      }

      // 5. Everything has landed: the reconciliation above was the last act.
      if (allLanded) {
        if (stackRow.status === "reconciled") return { _tag: "idle", stackId } as const;
        yield* setStackFields({ stackId, status: "reconciled" });
        yield* Effect.log("ADE publication reconciled a merged stack", {
          stackId,
          mergeShas: recordedMergeShas,
        });
        return { _tag: "advanced", stackId, status: "reconciled" } as const;
      }

      // 6. Refs: place bookmarks from durable change ids and push them. After a
      //    partial-merge refresh these are the *rebased* commits, so the
      //    surviving PRs show only their own diff.
      yield* publishRefs({ project, layers: unmerged });

      const bases = basesFor(stackRow, unmerged);
      // Reaching here with a settled status means the stack has layers that
      // never shipped — the lease is supposed to make that impossible, but if
      // it happens the stack is *live* again and must publish rather than
      // report itself idle and strand the work.
      const status: PublicationStackStatus =
        stackRow.status === "reconciled" || stackRow.status === "merged"
          ? "building"
          : (stackRow.status as PublicationStackStatus);

      /**
       * Publish the chained-PR way: create what is missing, and retarget what
       * exists onto its computed base. GitHub does not auto-retarget dependents.
       */
      const publishChained = Effect.fn("AdePublicationService.publishChained")(function* () {
        for (const layer of unmerged) {
          const base = bases.get(layer.publication_layer_id) ?? stackRow.base_bookmark;
          if (layer.pr_number === null || layer.pr_state === "closed") {
            // No live PR for this branch. `gh pr create` is not idempotent, so
            // the *next* pass adopts whatever this created by head branch
            // rather than trusting a number we might crash before writing.
            yield* repo.createPullRequest({
              repoPath: project.repoPath,
              baseBranch: base,
              bookmarkName: layer.bookmark_name,
              title: `Publication layer ${layer.layer_order + 1} (${layer.bookmark_name})`,
              body: `Layer ${layer.layer_order + 1} of ADE publication stack ${stackId}.`,
            });
            continue;
          }
          if (layer.pr_state === "open") {
            yield* repo.retargetPullRequest({
              repoPath: project.repoPath,
              prNumber: layer.pr_number,
              baseBranch: base,
            });
          }
        }
      });

      /**
       * Link the stack natively, or discover that this host has no stacked-PR
       * surface at all and durably downgrade to the chained fallback.
       *
       * The downgrade is one-way and happens *in this pass*: without it a host
       * lacking `gh stack` deferred every sweep forever, with no signal and no
       * route to the fallback the spec requires (ADR §8.1).
       */
      const linkOrDowngrade = Effect.fn("AdePublicationService.linkOrDowngrade")(function* () {
        const linked = yield* repo.linkStack({
          repoPath: project.repoPath,
          baseBranch: stackRow.base_bookmark,
          bookmarkNames: unmerged.map((layer) => layer.bookmark_name),
        });
        if (linked._tag === "linked") return true;
        yield* setStackFields({ stackId, mode: "chained" });
        yield* Effect.logWarning(
          "ADE publication downgraded to chained PRs: this host has no stacked-PR surface",
          { stackId, detail: linked.detail },
        );
        return false;
      });

      if (status === "building" || status === "review-frozen") {
        if (stackRow.mode === "native-stack") {
          // `gh stack link` creates whatever PRs are missing, correctly chained,
          // and is idempotent for PRs already in the stack. Running it every
          // pass is therefore the repair path as well as the create path.
          const native = yield* linkOrDowngrade();
          if (!native) {
            // Same pass, chained route — the stack still gets published today.
            yield* publishChained();
            return { _tag: "advanced", stackId, status } as const;
          }
          const stacks = yield* repo.readNativeStacks({ repoPath: project.repoPath });
          const prNumbers = new Set(
            layers
              .map((layer) => layer.pr_number)
              .filter((value): value is number => value !== null),
          );
          const mine =
            stacks.find((stack) => stack.pullRequestNumbers.some((pr) => prNumbers.has(pr))) ??
            stacks.find((stack) => stack.number === stackRow.native_stack_number);
          if (mine !== undefined) {
            // Presentation only (ADR §8.3) — recorded so S12 can link out, never
            // consulted as durable truth.
            yield* setStackFields({
              stackId,
              nativeStackNumber: mine.number,
              nativeStackNodeId: mine.nodeId,
              stackUrl: mine.url,
            });
          }
        } else {
          yield* publishChained();
        }
        return { _tag: "advanced", stackId, status } as const;
      }

      if (status === "merging") {
        if (stackRow.mode === "native-stack") {
          const stackNumber = stackRow.native_stack_number;
          if (stackNumber === null) {
            // The stack was never linked; link (or downgrade) on this pass and
            // merge on the next one rather than half-merging now.
            const native = yield* linkOrDowngrade();
            if (!native) yield* publishChained();
            return { _tag: "advanced", stackId, status } as const;
          }
          // `gh stack link` creates drafts and `gh stack merge` refuses drafts.
          yield* repo.markPullRequestsReady({
            repoPath: project.repoPath,
            prNumbers: unmerged
              .map((layer) => layer.pr_number)
              .filter((value): value is number => value !== null),
          });
          yield* repo.mergeStack({ repoPath: project.repoPath, stackNumber, mergeMethod });
        } else {
          // Bottom-up, one at a time, retargeting onto the base first: GitHub
          // does not auto-retarget dependents, so merging into a stale
          // publication branch is the failure this avoids.
          const bottom = unmerged[0];
          if (bottom !== undefined && bottom.pr_number !== null) {
            yield* repo.retargetPullRequest({
              repoPath: project.repoPath,
              prNumber: bottom.pr_number,
              baseBranch: stackRow.base_bookmark,
            });
            yield* repo.mergePullRequest({
              repoPath: project.repoPath,
              prNumber: bottom.pr_number,
              mergeMethod,
            });
          }
        }
        // Merged is never assumed here: the next pass re-reads GitHub and only
        // the observed merge SHAs move layers to `merged`.
        return { _tag: "advanced", stackId, status } as const;
      }

      return { _tag: "idle", stackId } as const;
    });

    const processStack: AdePublicationServiceShape["processStack"] = Effect.fn(
      "AdePublicationService.processStack",
    )(function* (stackId: PublicationStackId) {
      const stackRow = yield* requireStackRow(stackId);
      if (stackRow.status === "reconciled") {
        // Belt and braces behind the lease: if anything ever did land a layer on
        // a reconciled stack, treat the stack as live again rather than
        // silently never publishing that work.
        const outstanding = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM ade_publication_layers
          WHERE publication_stack_id = ${stackRow.publication_stack_id}
            AND status != 'merged'
        `.pipe(Effect.mapError(mapSql("processStack.outstanding")));
        if ((outstanding[0]?.n ?? 0) === 0) return { _tag: "idle", stackId } as const;
        yield* Effect.logWarning("ADE publication found unpublished layers on a reconciled stack", {
          stackId,
          outstanding: outstanding[0]?.n ?? 0,
        });
      }

      // An unpublishable project is a configuration problem, not a pass
      // failure: report it and leave the stack exactly where it is.
      const publishable = yield* requirePublishableProject(
        stackRow.project_id as AdeProjectId,
      ).pipe(
        Effect.catchTags({
          AdePublicationProjectNotFoundError: (error) => Effect.succeed(error.message),
          AdePublicationProjectNotPublishableError: (error) => Effect.succeed(error.message),
        }),
      );
      if (typeof publishable === "string") {
        return { _tag: "deferred", stackId, detail: publishable } as const;
      }

      const holder = yield* uuid;
      const claimed = yield* claimStack(stackRow.publication_stack_id, holder);
      if (claimed === null) return { _tag: "busy", stackId } as const;

      // Invariant 4 is enforced, not observed. The port already forbids jj from
      // snapshotting the working copy; this is the check that makes a
      // regression *fail the pass* instead of scrolling past in a log.
      //
      // A pass that cannot read the working copy before it starts has no
      // baseline to compare against, so it must not run at all: proceeding
      // would mean the one invariant with real corruption potential is
      // unenforced for that pass.
      const before = yield* repo
        .workingCopyFingerprint({ repoPath: publishable.repoPath })
        .pipe(Effect.catchTag("AdePublicationRepoError", () => Effect.succeed(null)));
      if (before === null) {
        yield* releaseStack(stackRow.publication_stack_id, holder);
        const detail =
          "the operated working copy could not be read, so the no-writes invariant cannot be enforced";
        yield* Effect.logWarning("ADE publication pass refused", { stackId, detail });
        return { _tag: "deferred", stackId, detail } as const;
      }

      const verified = yield* Ref.make(false);
      /**
       * Returns a violation detail, or `null` when the working copy is intact.
       * Runs at most once — the normal path consumes it so the outcome can be
       * changed; the `ensuring` path catches the abnormal exits (defect,
       * interruption) where there is no outcome left to change.
       */
      const verifyWorkingCopy = Effect.gen(function* () {
        if (yield* Ref.get(verified)) return null;
        yield* Ref.set(verified, true);
        const after = yield* repo
          .workingCopyFingerprint({ repoPath: publishable.repoPath })
          .pipe(Effect.catchTag("AdePublicationRepoError", () => Effect.succeed(null)));
        if (after === null) {
          return "the operated working copy could not be re-read after the pass";
        }
        if (after.commitId !== before.commitId) {
          return `the operated working copy moved from ${before.commitId} to ${after.commitId}`;
        }
        return null;
      });

      return yield* Effect.ensuring(
        Effect.gen(function* () {
          const outcome = yield* runPass({ stackRow: claimed, project: publishable }).pipe(
            Effect.catchTag("AdePublicationRepoError", (error) =>
              Effect.gen(function* () {
                // Mechanical failure. The stack keeps its state and the next
                // sweep re-runs the whole pass from remote truth (ADR §16.3).
                yield* Effect.logWarning("ADE publication pass deferred", {
                  stackId,
                  detail: error.message,
                });
                return { _tag: "deferred", stackId, detail: error.message } as const;
              }),
            ),
          );
          const violation = yield* verifyWorkingCopy;
          if (violation === null) return outcome;
          const error = new AdePublicationInvariantError({ stackId, detail: violation });
          yield* Effect.logError("ADE publication violated the no-writes invariant", {
            stackId,
            detail: violation,
          });
          // Never `advanced`: a pass that touched the workspace did something
          // nobody sanctioned, and reporting progress would hide it.
          return { _tag: "deferred", stackId, detail: error.message } as const;
        }),
        Effect.gen(function* () {
          const violation = yield* verifyWorkingCopy;
          if (violation !== null) {
            yield* Effect.logError("ADE publication violated the no-writes invariant", {
              stackId,
              detail: violation,
            });
          }
          yield* releaseStack(stackRow.publication_stack_id, holder);
        }).pipe(Effect.orDie),
      );
    });

    const runOnce: AdePublicationServiceShape["runOnce"] = Effect.fn(
      "AdePublicationService.runOnce",
    )(function* () {
      const rows = yield* sql<{
        readonly publication_stack_id: string;
        readonly project_id: string;
      }>`
        SELECT publication_stack_id, project_id FROM ade_publication_stacks
        WHERE status IN ('building', 'review-frozen', 'merging', 'merged')
        ORDER BY created_at ASC, rowid ASC
      `.pipe(Effect.mapError(mapSql("runOnce")));
      const stacks: Array<PublicationStackId> = [];
      for (const row of rows) {
        const stackId = row.publication_stack_id as PublicationStackId;
        // Adopt first, then publish: newly integrated work joins the stack in
        // the same sweep that pushes it (spec §4.5, ADR §14.5 tail handling).
        yield* adoptIntegratedCandidates(row.project_id as AdeProjectId).pipe(
          Effect.catchCause((cause) =>
            Effect.as(Effect.logWarning("ADE publication adoption failed", { cause, stackId }), {
              appended: [],
            }),
          ),
        );
        yield* processStack(stackId).pipe(
          Effect.catchCause((cause) =>
            Effect.as(Effect.logWarning("ADE publication pass failed", { cause, stackId }), {
              _tag: "idle",
              stackId,
            } as const),
          ),
        );
        stacks.push(stackId);
      }
      return { stacks };
    });

    const cleanupStack: AdePublicationServiceShape["cleanupStack"] = Effect.fn(
      "AdePublicationService.cleanupStack",
    )(function* (stackId: PublicationStackId) {
      const stackRow = yield* requireStackRow(stackId);
      // Invariant 5: deletion happens only *after* reconciliation. Deleting a
      // publication branch while the stack is live cascade-closes every PR that
      // depends on it, which is unrecoverable for those PRs' review history.
      if (stackRow.status !== "reconciled") {
        return yield* new AdePublicationStackStateError({
          stackId,
          expected: "reconciled",
          actual: stackRow.status,
        });
      }
      const project = yield* requirePublishableProject(stackRow.project_id as AdeProjectId).pipe(
        Effect.catchTags({
          AdePublicationProjectNotFoundError: () => Effect.succeed(null),
          AdePublicationProjectNotPublishableError: () => Effect.succeed(null),
        }),
      );
      if (project === null) return { deletedBookmarks: [] };

      const layers = yield* readLayerRows(stackRow.publication_stack_id).pipe(
        Effect.mapError(mapSql("cleanupStack.layers")),
      );
      const bookmarkNames = layers.map((layer) => layer.bookmark_name);
      // Cleanup is all-or-nothing per pass, and its report must be *true*:
      // claiming branches were deleted when the push failed leaks publication
      // refs and — worse — releases their names for reuse by the next stack,
      // which is how a fresh layer ends up adopting an ancestor's merged PR.
      const deleted = yield* repo
        .deleteBookmarks({
          repoPath: project.repoPath,
          remote: project.repoRemote,
          bookmarkNames,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTag("AdePublicationRepoError", (error) =>
            Effect.as(
              Effect.logWarning("ADE publication cleanup deferred", {
                stackId,
                detail: error.message,
              }),
              false,
            ),
          ),
        );
      if (!deleted) return { deletedBookmarks: [] };

      const at = yield* nowIso;
      // Only now does the stack stop owning its branch names.
      yield* setStackFields({ stackId, cleanedUpAt: at });
      yield* Effect.log("ADE publication cleaned up a reconciled stack", {
        stackId,
        bookmarkNames,
      });
      return { deletedBookmarks: bookmarkNames };
    });

    const recoverStacks: AdePublicationServiceShape["recoverStacks"] = Effect.fn(
      "AdePublicationService.recoverStacks",
    )(function* () {
      const at = yield* nowIso;
      // No mid-pass resume and no journal: recovery only reclaims leases whose
      // holder is gone. The next pass re-derives everything from GitHub, which
      // is the whole of ADR §16.3's "reconcile records against actual state".
      const rows = yield* sql<{ readonly publication_stack_id: string }>`
        UPDATE ade_publication_stacks
        SET lease_holder = NULL, lease_expires_at = NULL, updated_at = ${at}
        WHERE lease_holder IS NOT NULL
          AND (lease_expires_at IS NULL OR lease_expires_at <= ${at})
        RETURNING publication_stack_id
      `.pipe(Effect.mapError(mapSql("recoverStacks")));
      const released = rows.map((row) => row.publication_stack_id as PublicationStackId);
      if (released.length > 0) {
        yield* Effect.log("ADE publication released stale publication leases", { released });
      }
      return { released };
    });

    return AdePublicationService.of({
      openStack,
      appendLayer,
      adoptIntegratedCandidates,
      reorderLayers,
      getStack,
      getActiveStack,
      freezeStack,
      requestMerge,
      processStack,
      runOnce,
      cleanupStack,
      recoverStacks,
    });
  });

// ---------------------------------------------------------------------------
// Service tag & layers
// ---------------------------------------------------------------------------

export class AdePublicationService extends Context.Service<
  AdePublicationService,
  AdePublicationServiceShape
>()("shuv2code/ade/AdePublicationService") {
  static readonly layerWith = (
    options: AdePublicationServiceOptions = {},
  ): Layer.Layer<AdePublicationService, never, SqlClient.SqlClient | AdePublicationRepoPort> =>
    Layer.effect(AdePublicationService, make(options));

  static readonly layer = AdePublicationService.layerWith();

  /**
   * Background pass, mirroring the integration sweeper: release stale leases
   * once at activation (the restart convergence of ADR §16.3), then keep every
   * live stack converged against GitHub.
   */
  static readonly sweeperLive = (
    interval: Duration.Duration = ADE_PUBLICATION_SWEEP_INTERVAL_DEFAULT,
  ): Layer.Layer<never, never, AdePublicationService> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const service = yield* AdePublicationService;
        const guard = <A, E>(effect: Effect.Effect<A, E>, label: string) =>
          effect.pipe(
            Effect.catchCause((cause) => Effect.as(Effect.logWarning(label, { cause }), undefined)),
            Effect.catchDefect((defect) =>
              Effect.as(Effect.logWarning(label, { defect }), undefined),
            ),
          );
        yield* forkParked(
          Effect.gen(function* () {
            yield* guard(service.recoverStacks(), "ADE publication recovery failed");
            yield* Effect.repeat(
              guard(service.runOnce(), "ADE publication sweep failed"),
              Schedule.spaced(interval),
            );
          }),
        );
      }),
    );
}

export interface AdePublicationServiceOptions {
  /** How long a claim on a stack's pass survives without a refresh. */
  readonly leaseTtl?: Duration.Duration;
  /** Branch new stacks target; defaults to the canonical bookmark name. */
  readonly defaultBaseBookmark?: string;
  readonly mergeMethod?: "squash" | "merge" | "rebase";
}

/**
 * Slower than the integration sweep: every pass costs a fetch and several
 * GitHub reads, and publication has no user waiting on sub-minute latency.
 */
export const ADE_PUBLICATION_SWEEP_INTERVAL_DEFAULT = Duration.seconds(60);

/** Generous relative to a pass that may sit inside a whole-stack merge. */
export const ADE_PUBLICATION_LEASE_TTL_DEFAULT = Duration.minutes(15);
