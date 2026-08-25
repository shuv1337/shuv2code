// @effect-diagnostics nodeBuiltinImport:off
/**
 * ADE integration service (spec `docs/ade/ADE-V1-SPEC.md` §4.4, ADR §6.2–§6.3,
 * §7, §14.3–§14.4, §16.2 — issue #164).
 *
 * One candidate per project moves through
 * `queued → running → awaiting-review | awaiting-approval → integrated | bounced`,
 * and the project's queue is strictly serialized: a candidate parked on a gate
 * holds the queue, so every candidate is rebased fresh onto the *just-advanced*
 * canonical and a reviewer always sees the true final diff (ADR §7.2).
 *
 * Five invariants carry the design:
 *
 * 1. **One running candidate per project**, enforced three times: the partial
 *    unique index refuses a second running row, a lease over the running slot
 *    refuses a second worker adopting the *same* row, and the service refuses
 *    to start work while a candidate sits on a gate.
 * 2. **No per-step journal** (ADR §16.2). Nothing records "which step we
 *    reached". Recovery re-queues `running` rows whose lease has expired and
 *    the pass re-runs from scratch: upstream re-synced, workspace destroyed and
 *    recreated from canonical, checks re-executed.
 * 3. **Canonical advancement is idempotent and fast-forward only.** A pass that
 *    died after advancing canonical re-derives that fact from ancestry instead
 *    of re-rebasing an already-landed change (which reads as a conflict and
 *    would bounce the author for nothing). A candidate whose head canonical no
 *    longer descends from is re-queued for a fresh rebase, never forced.
 * 4. **Gate verdicts are durable and applied by the pass, not the caller.** An
 *    approval or rejection is recorded on the row and parks it back on
 *    `running`; a crash mid-integration converges on the next pass instead of
 *    stranding the project queue on a gate nobody will answer twice.
 * 5. **Repair, never retry** (ADR §13.3, §7.2). The repair assignment is
 *    created *before* the candidate is settled `bounced`, under a deterministic
 *    key, so a crash in between leaves the candidate running and the re-run
 *    re-emits exactly one repair. An unroutable author raises a Needs You item
 *    rather than vanishing into a log line.
 *
 * The service is backend-only; S12 renders the queue and S13 owns the captain
 * approval surface.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type AdeProjectId,
  type AssignmentId,
  type BotId,
  type DeclaredRisk,
  type IntegrationBounce,
  type IntegrationBounceReason,
  IntegrationBounce as IntegrationBounceSchema,
  type IntegrationCandidate,
  type IntegrationCandidateId,
  type IntegrationCandidateStatus,
  type IntegrationPolicy,
  type IntegrationVerdict,
  JJ_CHANGE_ID_PATTERN,
  LimitsConfig,
} from "@shuv2code/contracts";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { forkParked } from "../serverActivation.ts";
import { AdeAssignmentEngine } from "./AdeAssignmentEngine.ts";
import { AdeIntegrationRepoError, AdeIntegrationRepoPort } from "./AdeIntegrationRepoPort.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AdeIntegrationProjectNotFoundError extends Schema.TaggedErrorClass<AdeIntegrationProjectNotFoundError>()(
  "AdeIntegrationProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `ADE project '${this.projectId}' does not exist.`;
  }
}

/** Integration only applies to repo-bound projects (ADR §14.2). */
export class AdeIntegrationProjectNotRepoBoundError extends Schema.TaggedErrorClass<AdeIntegrationProjectNotRepoBoundError>()(
  "AdeIntegrationProjectNotRepoBoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `ADE project '${this.projectId}' has no repository binding, so it has no integration queue.`;
  }
}

export class AdeIntegrationCandidateNotFoundError extends Schema.TaggedErrorClass<AdeIntegrationCandidateNotFoundError>()(
  "AdeIntegrationCandidateNotFoundError",
  { candidateId: Schema.String },
) {
  override get message(): string {
    return `Integration candidate '${this.candidateId}' does not exist.`;
  }
}

/** A verdict arrived for a candidate that is not waiting for it. */
export class AdeIntegrationCandidateStateError extends Schema.TaggedErrorClass<AdeIntegrationCandidateStateError>()(
  "AdeIntegrationCandidateStateError",
  {
    candidateId: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
  },
) {
  override get message(): string {
    return `Integration candidate '${this.candidateId}' is '${this.actual}', not '${this.expected}'.`;
  }
}

/** The authoring bot never reviews its own change (ADR §7.2). */
export class AdeIntegrationReviewerMismatchError extends Schema.TaggedErrorClass<AdeIntegrationReviewerMismatchError>()(
  "AdeIntegrationReviewerMismatchError",
  {
    candidateId: Schema.String,
    expectedReviewerBotId: Schema.NullOr(Schema.String),
    actualReviewerBotId: Schema.String,
  },
) {
  override get message(): string {
    return `Integration candidate '${this.candidateId}' expects a review from '${this.expectedReviewerBotId ?? "nobody"}', not '${this.actualReviewerBotId}'.`;
  }
}

/** Canonical must not move under a running pass (ADR §14.3). */
export class AdeIntegrationBusyError extends Schema.TaggedErrorClass<AdeIntegrationBusyError>()(
  "AdeIntegrationBusyError",
  {
    projectId: Schema.String,
    candidateId: Schema.String,
  },
) {
  override get message(): string {
    return `ADE project '${this.projectId}' is integrating candidate '${this.candidateId}'; retry once it settles.`;
  }
}

export class AdeIntegrationCandidateEmptyError extends Schema.TaggedErrorClass<AdeIntegrationCandidateEmptyError>()(
  "AdeIntegrationCandidateEmptyError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `An integration candidate for project '${this.projectId}' must carry at least one change id.`;
  }
}

/**
 * Change ids arrive from bot tool calls and become `jj` arguments. Anything
 * outside JJ's reverse-hex alphabet is refused at the door — `all()`, `root()`,
 * and `--help` are all valid revsets/flags and none of them is a change id.
 */
export class AdeIntegrationChangeIdInvalidError extends Schema.TaggedErrorClass<AdeIntegrationChangeIdInvalidError>()(
  "AdeIntegrationChangeIdInvalidError",
  {
    projectId: Schema.String,
    changeId: Schema.String,
  },
) {
  override get message(): string {
    return `'${this.changeId}' is not a JJ change id, so it cannot enter project '${this.projectId}'s integration queue.`;
  }
}

// ---------------------------------------------------------------------------
// Gate policy (ADR §7.1–§7.2)
// ---------------------------------------------------------------------------

const GATE_ORDER: Record<IntegrationPolicy, number> = {
  automatic: 0,
  "agent-review": 1,
  "human-approval": 2,
};

/** Declared risk is the only classifier in V1 — no path globs (ADR §7.2). */
export const gateForDeclaredRisk = (risk: DeclaredRisk): IntegrationPolicy =>
  risk === "mechanical" ? "automatic" : risk === "protected" ? "human-approval" : "agent-review";

/**
 * The effective gate is the strictest of the project default and the declared
 * risk. Escalation raises it; nothing lowers it (ADR §7.1). Concretely: a bot
 * declaring `mechanical` in a project whose default is `agent-review` still
 * gets reviewed — "mechanical may skip review" is a property a project opts
 * into by setting its default to `automatic`, not something a bot can assert.
 */
export const effectiveIntegrationGate = (
  projectDefault: IntegrationPolicy,
  declaredRisk: DeclaredRisk,
): IntegrationPolicy => {
  const fromRisk = gateForDeclaredRisk(declaredRisk);
  return GATE_ORDER[fromRisk] >= GATE_ORDER[projectDefault] ? fromRisk : projectDefault;
};

/**
 * Order-insensitive identity for a change set, so repeat-bounce detection sees
 * `["a","b"]` and `["b","a"]` as the same work. Safe to join on `|` because
 * change ids are constrained to `[k-z]`.
 */
export const changeSetKey = (changeIds: ReadonlyArray<string>): string =>
  [...changeIds].sort().join("|");

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

export interface EnqueueCandidateInput {
  readonly projectId: AdeProjectId;
  readonly sourceAssignmentIds: ReadonlyArray<AssignmentId>;
  readonly changeIds: ReadonlyArray<string>;
  /** Repairs route back here (ADR §6.3). */
  readonly originatingBotId: BotId;
  readonly declaredRisk?: DeclaredRisk;
  /** Defaults to the source assignment ids, so a replayed tool call is a no-op. */
  readonly idempotencyKey?: string;
}

export interface EnqueueCandidateOutcome {
  readonly candidate: IntegrationCandidate;
  /** False when a *live* candidate already held this key for the project. */
  readonly created: boolean;
}

export type ProcessQueueHeadOutcome =
  /** No queued or running candidate for this project. */
  | { readonly _tag: "idle" }
  /** A candidate is parked on its gate; the queue stays held (ADR §7.2). */
  | { readonly _tag: "waiting"; readonly candidateId: IntegrationCandidateId }
  /** Another worker holds the running slot (index or lease refused us). */
  | { readonly _tag: "busy" }
  /** The pass ran and settled the candidate into a durable state. */
  | {
      readonly _tag: "advanced";
      readonly candidateId: IntegrationCandidateId;
      readonly status: IntegrationCandidateStatus;
    }
  /** A mechanical failure; the candidate stays on the queue head and re-runs. */
  | {
      readonly _tag: "deferred";
      readonly candidateId: IntegrationCandidateId;
      readonly detail: string;
    };

export interface SubmitReviewInput {
  readonly candidateId: IntegrationCandidateId;
  readonly reviewerBotId: BotId;
  readonly decision: "approve" | "reject";
  readonly feedback?: string;
}

export interface SubmitApprovalInput {
  readonly candidateId: IntegrationCandidateId;
  readonly decision: "approve" | "deny";
  readonly note?: string;
}

export interface RecoverOutcome {
  readonly requeued: ReadonlyArray<IntegrationCandidateId>;
}

export interface RunOnceOutcome {
  readonly projects: ReadonlyArray<AdeProjectId>;
}

export interface SweepRetainedWorkspacesOutcome {
  readonly cleaned: ReadonlyArray<IntegrationCandidateId>;
}

export type SubmitVerdictError =
  | AdeIntegrationBusyError
  | AdeIntegrationCandidateNotFoundError
  | AdeIntegrationCandidateStateError
  | AdeIntegrationProjectNotFoundError
  | AdeIntegrationProjectNotRepoBoundError
  | PersistenceSqlError;

export interface AdeIntegrationServiceShape {
  /** Idempotent enqueue; the queue is FIFO by creation time. */
  readonly enqueueCandidate: (
    input: EnqueueCandidateInput,
  ) => Effect.Effect<
    EnqueueCandidateOutcome,
    | AdeIntegrationCandidateEmptyError
    | AdeIntegrationChangeIdInvalidError
    | AdeIntegrationProjectNotFoundError
    | AdeIntegrationProjectNotRepoBoundError
    | PersistenceSqlError
  >;
  readonly getCandidate: (
    candidateId: IntegrationCandidateId,
  ) => Effect.Effect<IntegrationCandidate | null, PersistenceSqlError>;
  readonly listCandidates: (
    projectId: AdeProjectId,
    options?: { readonly statuses?: ReadonlyArray<IntegrationCandidateStatus> },
  ) => Effect.Effect<ReadonlyArray<IntegrationCandidate>, PersistenceSqlError>;
  /** Drive the project's queue head one pass. Safe to call repeatedly. */
  readonly processQueueHead: (
    projectId: AdeProjectId,
  ) => Effect.Effect<
    ProcessQueueHeadOutcome,
    | AdeIntegrationProjectNotFoundError
    | AdeIntegrationProjectNotRepoBoundError
    | PersistenceSqlError
  >;
  /** One sweep across every project holding queued or running work. */
  readonly runOnce: () => Effect.Effect<RunOnceOutcome, PersistenceSqlError>;
  readonly submitReview: (
    input: SubmitReviewInput,
  ) => Effect.Effect<
    IntegrationCandidate,
    SubmitVerdictError | AdeIntegrationReviewerMismatchError
  >;
  readonly submitApproval: (
    input: SubmitApprovalInput,
  ) => Effect.Effect<IntegrationCandidate, SubmitVerdictError>;
  /** Explicit upstream sync (ADR §14.3) — captain/Second Mate triggered. */
  readonly syncUpstream: (
    projectId: AdeProjectId,
  ) => Effect.Effect<
    { readonly advanced: boolean; readonly conflictDetail: string | null },
    | AdeIntegrationBusyError
    | AdeIntegrationProjectNotFoundError
    | AdeIntegrationProjectNotRepoBoundError
    | PersistenceSqlError
  >;
  /** Release a bounced candidate's retained forensic workspace (ADR §14.4). */
  readonly cleanupCandidateWorkspace: (
    candidateId: IntegrationCandidateId,
  ) => Effect.Effect<
    IntegrationCandidate,
    AdeIntegrationCandidateNotFoundError | PersistenceSqlError
  >;
  /** The age-based half of ADR §14.4's retention rule. */
  readonly sweepRetainedWorkspaces: () => Effect.Effect<
    SweepRetainedWorkspacesOutcome,
    PersistenceSqlError
  >;
  /** Restart recovery: expired-lease running rows go back on the queue head. */
  readonly recoverRunningCandidates: () => Effect.Effect<RecoverOutcome, PersistenceSqlError>;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Exported so read-only captain projections (S12's project view) reuse this
 * service's decode rules instead of re-deriving them from the DDL.
 */
export interface CandidateRow {
  readonly integration_candidate_id: string;
  readonly project_id: string;
  readonly idempotency_key: string;
  readonly source_assignment_ids_json: string;
  readonly change_ids_json: string;
  readonly change_ids_key: string;
  readonly originating_bot_id: string;
  readonly declared_risk: string;
  readonly status: string;
  readonly gate: string | null;
  readonly reviewer_bot_id: string | null;
  readonly workspace_path: string | null;
  readonly verdict: string | null;
  readonly verdict_at: string | null;
  readonly verdict_by_bot_id: string | null;
  readonly verdict_detail: string | null;
  readonly lease_holder: string | null;
  readonly lease_expires_at: string | null;
  readonly bounce_count: number;
  readonly bounce_json: string | null;
  readonly repair_assignment_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ProjectRow {
  readonly project_id: string;
  readonly second_mate_bot_id: string;
  readonly repo_path: string | null;
  readonly repo_remote: string | null;
  readonly integration_policy_default: string;
  readonly check_commands_json: string;
}

interface RepoBoundProject {
  readonly projectId: AdeProjectId;
  readonly secondMateBotId: BotId;
  readonly repoPath: string;
  readonly repoRemote: string | null;
  readonly integrationPolicyDefault: IntegrationPolicy;
  readonly checkCommands: ReadonlyArray<string>;
}

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeStringArray = Schema.decodeUnknownEffect(StringArrayJson);
const encodeStringArray = Schema.encodeEffect(StringArrayJson);
const BounceJson = Schema.fromJsonString(IntegrationBounceSchema);
const decodeBounce = Schema.decodeUnknownEffect(BounceJson);
const encodeBounce = Schema.encodeEffect(BounceJson);
const decodeLimitsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(LimitsConfig));
const decodeLimitsDefaults = Schema.decodeUnknownEffect(LimitsConfig);
/**
 * A structural projection of `NeedsYouSubjectRef` — the service only ever
 * reads back the ids it wrote, so it does not need the full branded union.
 */
const SubjectRefsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      _tag: Schema.String,
      integrationCandidateId: Schema.optional(Schema.String),
      projectId: Schema.optional(Schema.String),
      botId: Schema.optional(Schema.String),
    }),
  ),
);
const encodeSubjectRefs = Schema.encodeEffect(SubjectRefsJson);
const decodeSubjectRefs = Schema.decodeUnknownEffect(SubjectRefsJson);

export const rowToCandidate = Effect.fn("AdeIntegrationService.rowToCandidate")(function* (
  row: CandidateRow,
) {
  const sourceAssignmentIds = yield* decodeStringArray(row.source_assignment_ids_json);
  const changeIds = yield* decodeStringArray(row.change_ids_json);
  const bounce =
    row.bounce_json === null ? null : ((yield* decodeBounce(row.bounce_json)) as IntegrationBounce);
  return {
    id: row.integration_candidate_id as IntegrationCandidateId,
    projectId: row.project_id as AdeProjectId,
    idempotencyKey: row.idempotency_key,
    sourceAssignmentIds: sourceAssignmentIds as ReadonlyArray<AssignmentId>,
    changeIds: changeIds as IntegrationCandidate["changeIds"],
    originatingBotId: row.originating_bot_id as BotId,
    declaredRisk: row.declared_risk as DeclaredRisk,
    status: row.status as IntegrationCandidateStatus,
    gate: row.gate as IntegrationPolicy | null,
    reviewerBotId: row.reviewer_bot_id as BotId | null,
    workspacePath: row.workspace_path,
    verdict: row.verdict as IntegrationVerdict | null,
    verdictAt: row.verdict_at,
    verdictByBotId: row.verdict_by_bot_id as BotId | null,
    verdictDetail: row.verdict_detail,
    bounceCount: row.bounce_count,
    bounce,
    repairAssignmentId: row.repair_assignment_id as AssignmentId | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies IntegrationCandidate;
}, Effect.orDie);

const advancedTo = (
  candidateId: string,
  status: IntegrationCandidateStatus,
): ProcessQueueHeadOutcome => ({
  _tag: "advanced",
  candidateId: candidateId as IntegrationCandidateId,
  status,
});

const renderCheckFailures = (
  failures: ReadonlyArray<{
    readonly command: string;
    readonly exitCode: number | null;
    readonly output: string;
  }>,
): string =>
  failures
    .map(
      (failure) =>
        `$ ${failure.command}\nexit: ${failure.exitCode ?? "timeout"}\n${failure.output}`,
    )
    .join("\n\n");

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const make = (options: AdeIntegrationServiceOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* AdeIntegrationRepoPort;
    const assignments = yield* AdeAssignmentEngine;
    const path = yield* Path.Path;

    const workspaceRoot =
      options.workspaceRoot ?? path.join(NodeOS.homedir(), ".ade", "workspaces");
    const leaseTtl = options.leaseTtl ?? ADE_INTEGRATION_LEASE_TTL_DEFAULT;
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const leaseExpiryIso = Effect.map(DateTime.now, (now) =>
      DateTime.formatIso(DateTime.addDuration(now, leaseTtl)),
    );
    const uuid = Effect.sync(() => NodeCrypto.randomUUID());
    const mapSql = (operation: string) =>
      toPersistenceSqlError(`AdeIntegrationService.${operation}`);

    const workspaceNameFor = (candidateId: string) => `ade-candidate-${candidateId}`;
    const workspacePathFor = (projectId: string, candidateId: string) =>
      path.join(workspaceRoot, projectId, candidateId);

    const readCandidateRow = (candidateId: string) =>
      sql<CandidateRow>`
        SELECT * FROM ade_integration_candidates
        WHERE integration_candidate_id = ${candidateId}
      `;

    const requireCandidate = Effect.fn("AdeIntegrationService.requireCandidate")(function* (
      candidateId: IntegrationCandidateId,
    ) {
      const rows = yield* readCandidateRow(candidateId).pipe(
        Effect.mapError(mapSql("requireCandidate")),
      );
      const row = rows[0];
      if (row === undefined) {
        return yield* new AdeIntegrationCandidateNotFoundError({ candidateId });
      }
      return row;
    });

    const requireRepoBoundProject = Effect.fn("AdeIntegrationService.requireRepoBoundProject")(
      function* (projectId: AdeProjectId) {
        const rows = yield* sql<ProjectRow>`
          SELECT project_id, second_mate_bot_id, repo_path, repo_remote,
                 integration_policy_default, check_commands_json
          FROM ade_projects WHERE project_id = ${projectId}
        `.pipe(Effect.mapError(mapSql("requireRepoBoundProject")));
        const row = rows[0];
        if (row === undefined) {
          return yield* new AdeIntegrationProjectNotFoundError({ projectId });
        }
        if (row.repo_path === null) {
          return yield* new AdeIntegrationProjectNotRepoBoundError({ projectId });
        }
        const checkCommands = yield* Effect.orDie(decodeStringArray(row.check_commands_json));
        return {
          projectId: row.project_id as AdeProjectId,
          secondMateBotId: row.second_mate_bot_id as BotId,
          repoPath: row.repo_path,
          repoRemote: row.repo_remote,
          integrationPolicyDefault: row.integration_policy_default as IntegrationPolicy,
          checkCommands,
        } satisfies RepoBoundProject;
      },
    );

    const readLimits = Effect.gen(function* () {
      const rows = yield* sql<{ readonly config_json: string }>`
        SELECT config_json FROM ade_limits_config WHERE id = 1
      `;
      const json = rows[0]?.config_json;
      return json === undefined
        ? yield* Effect.orDie(decodeLimitsDefaults({}))
        : yield* Effect.orDie(decodeLimitsJson(json));
    });

    // -----------------------------------------------------------------------
    // Enqueue / reads
    // -----------------------------------------------------------------------

    const enqueueCandidate: AdeIntegrationServiceShape["enqueueCandidate"] = Effect.fn(
      "AdeIntegrationService.enqueueCandidate",
    )(function* (input: EnqueueCandidateInput) {
      yield* requireRepoBoundProject(input.projectId);
      if (input.changeIds.length === 0) {
        return yield* new AdeIntegrationCandidateEmptyError({ projectId: input.projectId });
      }
      // Validate before anything is persisted: a hostile change id must never
      // reach the port, let alone `jj`.
      for (const changeId of input.changeIds) {
        if (!JJ_CHANGE_ID_PATTERN.test(changeId)) {
          return yield* new AdeIntegrationChangeIdInvalidError({
            projectId: input.projectId,
            changeId,
          });
        }
      }
      const idempotencyKey =
        input.idempotencyKey ??
        (input.sourceAssignmentIds.length > 0
          ? input.sourceAssignmentIds.join("|")
          : input.changeIds.join("|"));

      // Replay only matches a *live* candidate. A settled one must not burn the
      // key: after a bounce, the repaired change comes back under the same
      // tool-call-derived key and has to queue a fresh candidate.
      const existing = yield* sql<CandidateRow>`
        SELECT * FROM ade_integration_candidates
        WHERE project_id = ${input.projectId}
          AND idempotency_key = ${idempotencyKey}
          AND status NOT IN ('integrated', 'bounced')
      `.pipe(Effect.mapError(mapSql("enqueueCandidate.replay")));
      const replay = existing[0];
      if (replay !== undefined) {
        return { candidate: yield* rowToCandidate(replay), created: false };
      }

      const candidateId = yield* uuid;
      const at = yield* nowIso;
      const sourceJson = yield* Effect.orDie(
        encodeStringArray([...input.sourceAssignmentIds] as ReadonlyArray<string>),
      );
      const changesJson = yield* Effect.orDie(encodeStringArray([...input.changeIds]));
      const inserted = yield* sql<CandidateRow>`
        INSERT INTO ade_integration_candidates (
          integration_candidate_id, project_id, idempotency_key,
          source_assignment_ids_json, change_ids_json, change_ids_key,
          originating_bot_id, declared_risk, status, gate, reviewer_bot_id,
          workspace_path, verdict, verdict_at, verdict_by_bot_id, verdict_detail,
          lease_holder, lease_expires_at,
          bounce_count, bounce_json, repair_assignment_id, created_at, updated_at
        ) VALUES (
          ${candidateId}, ${input.projectId}, ${idempotencyKey},
          ${sourceJson}, ${changesJson}, ${changeSetKey(input.changeIds)},
          ${input.originatingBotId}, ${input.declaredRisk ?? "normal"}, 'queued', NULL, NULL,
          NULL, NULL, NULL, NULL, NULL,
          NULL, NULL,
          0, NULL, NULL, ${at}, ${at}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `.pipe(Effect.mapError(mapSql("enqueueCandidate.insert")));
      const row = inserted[0];
      if (row !== undefined) {
        return { candidate: yield* rowToCandidate(row), created: true };
      }
      // Lost the race against the per-project idempotency index: re-read.
      const raced = yield* sql<CandidateRow>`
        SELECT * FROM ade_integration_candidates
        WHERE project_id = ${input.projectId}
          AND idempotency_key = ${idempotencyKey}
          AND status NOT IN ('integrated', 'bounced')
      `.pipe(Effect.mapError(mapSql("enqueueCandidate.raced")));
      const racedRow = raced[0];
      if (racedRow === undefined) {
        return yield* Effect.die(
          new Error("integration candidate insert reported an impossible conflict"),
        );
      }
      return { candidate: yield* rowToCandidate(racedRow), created: false };
    });

    const getCandidate: AdeIntegrationServiceShape["getCandidate"] = Effect.fn(
      "AdeIntegrationService.getCandidate",
    )(function* (candidateId: IntegrationCandidateId) {
      const rows = yield* readCandidateRow(candidateId).pipe(
        Effect.mapError(mapSql("getCandidate")),
      );
      const row = rows[0];
      return row === undefined ? null : yield* rowToCandidate(row);
    });

    const listCandidates: AdeIntegrationServiceShape["listCandidates"] = Effect.fn(
      "AdeIntegrationService.listCandidates",
    )(function* (
      projectId: AdeProjectId,
      listOptions?: { readonly statuses?: ReadonlyArray<IntegrationCandidateStatus> },
    ) {
      const statuses = listOptions?.statuses;
      const rows = yield* sql<CandidateRow>`
        SELECT * FROM ade_integration_candidates
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, rowid ASC
      `.pipe(Effect.mapError(mapSql("listCandidates")));
      const filtered = rows.filter(
        (row) =>
          statuses === undefined || statuses.includes(row.status as IntegrationCandidateStatus),
      );
      return yield* Effect.forEach(filtered, rowToCandidate);
    });

    // -----------------------------------------------------------------------
    // Row transitions
    // -----------------------------------------------------------------------

    const settle = Effect.fn("AdeIntegrationService.settle")(function* (input: {
      readonly candidateId: string;
      readonly status: IntegrationCandidateStatus;
      readonly gate?: IntegrationPolicy | null;
      readonly reviewerBotId?: BotId | null;
      readonly workspacePath?: string | null;
      readonly bounce?: IntegrationBounce | null;
      readonly repairAssignmentId?: string | null;
      readonly leaseHolder?: string | null;
      readonly leaseExpiresAt?: string | null;
      readonly bumpBounceCount?: boolean;
    }) {
      const at = yield* nowIso;
      const bounceJson =
        input.bounce === undefined || input.bounce === null
          ? null
          : yield* Effect.orDie(encodeBounce(input.bounce));
      // Read-then-write inside one transaction so omitted fields keep their
      // current value without embedding SQL fragments in the update.
      const rows = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* readCandidateRow(input.candidateId);
            const row = current[0];
            if (row === undefined) return [] as ReadonlyArray<CandidateRow>;
            return yield* sql<CandidateRow>`
              UPDATE ade_integration_candidates SET
                status = ${input.status},
                gate = ${input.gate === undefined ? row.gate : (input.gate ?? null)},
                reviewer_bot_id = ${
                  input.reviewerBotId === undefined
                    ? row.reviewer_bot_id
                    : (input.reviewerBotId ?? null)
                },
                workspace_path = ${
                  input.workspacePath === undefined
                    ? row.workspace_path
                    : (input.workspacePath ?? null)
                },
                repair_assignment_id = ${
                  input.repairAssignmentId === undefined
                    ? row.repair_assignment_id
                    : (input.repairAssignmentId ?? null)
                },
                lease_holder = ${
                  input.leaseHolder === undefined ? row.lease_holder : (input.leaseHolder ?? null)
                },
                lease_expires_at = ${
                  input.leaseExpiresAt === undefined
                    ? row.lease_expires_at
                    : (input.leaseExpiresAt ?? null)
                },
                bounce_json = ${input.bounce === undefined ? row.bounce_json : bounceJson},
                bounce_count = ${row.bounce_count + (input.bumpBounceCount === true ? 1 : 0)},
                updated_at = ${at}
              WHERE integration_candidate_id = ${input.candidateId}
              RETURNING *
            `;
          }),
        )
        .pipe(Effect.mapError(mapSql("settle")));
      const row = rows[0];
      if (row === undefined) {
        return yield* Effect.die(new Error("integration candidate vanished mid-transition"));
      }
      return row;
    });

    /** Extend our hold on the running slot. Returns false once we have lost it. */
    const refreshLease = Effect.fn("AdeIntegrationService.refreshLease")(function* (
      candidateId: string,
      holder: string,
    ) {
      const expiresAt = yield* leaseExpiryIso;
      const rows = yield* sql<{ readonly integration_candidate_id: string }>`
        UPDATE ade_integration_candidates
        SET lease_expires_at = ${expiresAt}
        WHERE integration_candidate_id = ${candidateId}
          AND status = 'running'
          AND lease_holder = ${holder}
        RETURNING integration_candidate_id
      `.pipe(Effect.mapError(mapSql("refreshLease")));
      return rows.length === 1;
    });

    // -----------------------------------------------------------------------
    // Needs You (S13 renders these; the row is the durable item)
    // -----------------------------------------------------------------------

    /**
     * DB-backed dedupe, mirroring the health checker: one open item per
     * candidate, so a re-running pass cannot pile up duplicates.
     */
    const openUnroutableRepairItem = Effect.fn("AdeIntegrationService.openUnroutableRepairItem")(
      function* (candidateId: string) {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const open = yield* sql<{ readonly subject_refs_json: string }>`
              SELECT subject_refs_json FROM ade_needs_you_items
              WHERE kind = 'stall' AND status = 'open'
            `;
              for (const row of open) {
                const refs = yield* Effect.orElseSucceed(
                  decodeSubjectRefs(row.subject_refs_json),
                  () => [],
                );
                if (
                  refs.some(
                    (ref) =>
                      ref._tag === "integrationCandidate" &&
                      ref.integrationCandidateId === candidateId,
                  )
                ) {
                  return;
                }
              }
              const id = yield* uuid;
              const at = yield* nowIso;
              const subjectRefs = yield* Effect.orDie(
                encodeSubjectRefs([
                  { _tag: "integrationCandidate", integrationCandidateId: candidateId },
                ]),
              );
              yield* sql`
              INSERT INTO ade_needs_you_items (
                needs_you_item_id, kind, subject_refs_json, status,
                created_at, updated_at, resolved_at
              ) VALUES (${id}, 'stall', ${subjectRefs}, 'open', ${at}, ${at}, NULL)
            `;
            }),
          )
          .pipe(Effect.mapError(mapSql("openUnroutableRepairItem")));
      },
    );

    /**
     * Park an `approval` item on the captain (spec §7 slice 5). Same DB-backed
     * dedupe as the stall item above: parking is re-derived on every recovery
     * pass (ADR §16.2 has no journal), so without it a restart loop would pile
     * up one inbox row per pass for a single waiting candidate.
     */
    const openApprovalItem = Effect.fn("AdeIntegrationService.openApprovalItem")(function* (input: {
      readonly candidateId: string;
      readonly projectId: string;
      readonly originatingBotId: string | null;
    }) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const open = yield* sql<{ readonly subject_refs_json: string }>`
              SELECT subject_refs_json FROM ade_needs_you_items
              WHERE kind = 'approval' AND status = 'open'
            `;
            for (const row of open) {
              const refs = yield* Effect.orElseSucceed(
                decodeSubjectRefs(row.subject_refs_json),
                () => [],
              );
              if (
                refs.some(
                  (ref) =>
                    ref._tag === "integrationCandidate" &&
                    ref.integrationCandidateId === input.candidateId,
                )
              ) {
                return;
              }
            }
            const id = yield* uuid;
            const at = yield* nowIso;
            const subjectRefs = yield* Effect.orDie(
              encodeSubjectRefs([
                { _tag: "integrationCandidate", integrationCandidateId: input.candidateId },
                { _tag: "project", projectId: input.projectId },
                ...(input.originatingBotId === null
                  ? []
                  : ([{ _tag: "bot", botId: input.originatingBotId }] as const)),
              ] as Parameters<typeof encodeSubjectRefs>[0]),
            );
            yield* sql`
              INSERT INTO ade_needs_you_items (
                needs_you_item_id, kind, subject_refs_json, status,
                created_at, updated_at, resolved_at
              ) VALUES (${id}, 'approval', ${subjectRefs}, 'open', ${at}, ${at}, NULL)
            `;
          }),
        )
        .pipe(Effect.mapError(mapSql("openApprovalItem")));
    });

    /**
     * The candidate is no longer waiting on the captain, so neither is the
     * item — whichever rendering (inbox or inline) produced the verdict, and
     * even when the verdict never came from a rendering at all. This is what
     * makes the item resolve exactly once: `claimForVerdict` is the single
     * conditional exit from `awaiting-approval`.
     */
    const resolveApprovalItems = Effect.fn("AdeIntegrationService.resolveApprovalItems")(function* (
      candidateId: string,
    ) {
      const at = yield* nowIso;
      yield* sql`
          UPDATE ade_needs_you_items
          SET status = 'resolved', resolved_at = ${at}, updated_at = ${at}
          WHERE kind = 'approval'
            AND status = 'open'
            AND subject_refs_json LIKE ${`%"integrationCandidateId":"${candidateId}"%`}
        `.pipe(Effect.mapError(mapSql("resolveApprovalItems")));
    });

    // -----------------------------------------------------------------------
    // Bounce (ADR §7.2, §13.3, §14.4)
    // -----------------------------------------------------------------------

    /**
     * The repair assignment is created *first*, under a candidate-scoped
     * deterministic key. A crash between the two writes leaves the candidate
     * `running`, so the re-run re-emits — and idempotent creation collapses it
     * to the same single repair. Settling first (and swallowing a failed
     * creation) is how a bounce silently loses its repair forever.
     */
    const bounce = Effect.fn("AdeIntegrationService.bounce")(function* (input: {
      readonly project: RepoBoundProject;
      readonly candidate: CandidateRow;
      readonly reason: IntegrationBounceReason;
      readonly detail: string;
      readonly workspacePath: string | null;
    }) {
      const at = yield* nowIso;
      const detail = input.detail.slice(0, 16_384);
      const candidateId = input.candidate.integration_candidate_id;
      const changeIds = yield* Effect.orDie(decodeStringArray(input.candidate.change_ids_json));
      const sourceIds = yield* Effect.orDie(
        decodeStringArray(input.candidate.source_assignment_ids_json),
      );
      const retainedWorkspace = input.workspacePath ?? input.candidate.workspace_path;

      const instruction = [
        `Integration bounced this change back to you (${input.reason}).`,
        ``,
        `Project: ${input.project.projectId}`,
        `Candidate: ${candidateId}`,
        `Changes: ${changeIds.join(", ")}`,
        ...(retainedWorkspace !== null ? [`Retained workspace: ${retainedWorkspace}`] : []),
        ``,
        detail,
        ``,
        `Fix the change and submit a new integration candidate; this is a new assignment, not a retry.`,
      ].join("\n");

      const repair = yield* assignments
        .createAssignment({
          requester: { _tag: "bot", botId: input.project.secondMateBotId },
          recipientBotId: input.candidate.originating_bot_id as BotId,
          instruction,
          idempotencyKey: `ade-integration-repair:${candidateId}`,
          declaredRisk: input.candidate.declared_risk as DeclaredRisk,
          projectId: input.project.projectId,
          parentAssignmentId: (sourceIds[0] as AssignmentId | undefined) ?? null,
        })
        .pipe(
          Effect.map((outcome) => outcome.assignment.id as string),
          // The author is gone (archived or deleted). There is nobody to repair
          // this, so it becomes the captain's problem as a durable Needs You
          // item rather than a warning nobody reads.
          Effect.catchTags({
            AdeBotNotFoundError: () => Effect.succeed(null),
            AdeBotArchivedError: () => Effect.succeed(null),
          }),
          // Anything else (a full queue, a vanished parent) is a transient
          // failure to *emit*, not a reason to settle a bounce without its
          // repair. Route it into the pipeline's existing "mechanical failure,
          // re-run from scratch" channel: the candidate stays `running`, the
          // lease lapses, and the next pass re-emits under the same key.
          Effect.mapError(
            (cause) =>
              new AdeIntegrationRepoError({
                operation: "bounce.repair",
                detail: cause.message,
              }),
          ),
        );
      if (repair === null) {
        yield* openUnroutableRepairItem(candidateId);
        yield* Effect.logWarning("ADE integration repair is unroutable", {
          candidateId,
          originatingBotId: input.candidate.originating_bot_id,
        });
      }

      const row = yield* settle({
        candidateId,
        status: "bounced",
        ...(retainedWorkspace !== null ? { workspacePath: retainedWorkspace } : {}),
        bounce: { reason: input.reason, detail, at },
        repairAssignmentId: repair,
        leaseHolder: null,
        leaseExpiresAt: null,
        bumpBounceCount: true,
      });

      // Repeated bounces on the same change set notify the Second Mate, who may
      // reroute or escalate. No hard bounce cap in V1 (ADR §7.2). The comparison
      // is order-insensitive via change_ids_key.
      const priorBounces = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ade_integration_candidates
        WHERE project_id = ${input.project.projectId}
          AND status = 'bounced'
          AND change_ids_key = ${row.change_ids_key}
          AND integration_candidate_id != ${candidateId}
      `.pipe(Effect.mapError(mapSql("bounce.priorBounces")));
      const priorCount = priorBounces[0]?.n ?? 0;
      if (priorCount > 0 && input.project.secondMateBotId !== input.candidate.originating_bot_id) {
        yield* assignments
          .createAssignment({
            requester: { _tag: "captain" },
            recipientBotId: input.project.secondMateBotId,
            instruction: [
              `Change set ${changeIds.join(", ")} has now bounced ${priorCount + 1} times in project ${input.project.projectId}.`,
              `Latest bounce (${input.reason}):`,
              ``,
              detail,
              ``,
              `Reroute to a Reviewer/Integrator or escalate to the captain.`,
            ].join("\n"),
            idempotencyKey: `ade-integration-bounce-notice:${candidateId}`,
            declaredRisk: "normal",
            projectId: input.project.projectId,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.logWarning("ADE integration bounce notice failed", { cause, candidateId }),
                null,
              ),
            ),
          );
      }

      return row;
    });

    // -----------------------------------------------------------------------
    // Canonical advancement (ADR §6.3, §16.2)
    // -----------------------------------------------------------------------

    // `integrate` reports one of three outcomes: `integrated` (canonical moved
    // or already contained the head), `requeued` (canonical diverged — never
    // forced backwards), or `lost` (the running lease lapsed under us).
    const integrate = Effect.fn("AdeIntegrationService.integrate")(function* (input: {
      readonly project: RepoBoundProject;
      readonly candidate: CandidateRow;
      readonly gate: IntegrationPolicy;
      readonly leaseHolder: string | null;
    }) {
      const candidateId = input.candidate.integration_candidate_id;
      const changeIds = yield* Effect.orDie(decodeStringArray(input.candidate.change_ids_json));
      const headRevision = changeIds[changeIds.length - 1] as string;

      // Re-assert the lease immediately before the durable commit point: if it
      // lapsed, another worker may already be rebasing this candidate and two
      // advancements would race over the same bookmark.
      if (input.leaseHolder !== null) {
        const held = yield* refreshLease(candidateId, input.leaseHolder);
        if (!held) return { _tag: "lost" } as const;
      }

      const advanced = yield* repo.advanceCanonical({
        repoPath: input.project.repoPath,
        headRevision,
      });
      if (advanced._tag === "diverged") {
        // Never force the bookmark backwards — that drops whatever landed in
        // between. Put the candidate back on the queue head for a fresh rebase;
        // its recorded verdict rides along, so an approval is not re-asked.
        yield* settle({
          candidateId,
          status: "queued",
          leaseHolder: null,
          leaseExpiresAt: null,
        });
        yield* Effect.logInfo("ADE integration re-queued a diverged candidate", {
          candidateId,
          detail: advanced.detail,
        });
        return { _tag: "requeued", detail: advanced.detail } as const;
      }

      const workspacePath =
        input.candidate.workspace_path ?? workspacePathFor(input.project.projectId, candidateId);
      yield* repo
        .cleanupWorkspace({
          repoPath: input.project.repoPath,
          workspacePath,
          workspaceName: workspaceNameFor(candidateId),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning("ADE integration workspace cleanup failed", { cause, candidateId }),
              undefined,
            ),
          ),
        );

      const row = yield* settle({
        candidateId,
        status: "integrated",
        gate: input.gate,
        workspacePath: null,
        leaseHolder: null,
        leaseExpiresAt: null,
      });
      yield* Effect.log("ADE integration advanced canonical", {
        candidateId,
        projectId: input.project.projectId,
        canonicalCommitId: advanced.canonicalCommitId,
        alreadyIntegrated: advanced._tag === "already-integrated",
      });
      return { _tag: "integrated", row } as const;
    });

    // -----------------------------------------------------------------------
    // Reviewer routing (ADR §7.2)
    // -----------------------------------------------------------------------

    const resolveReviewer = Effect.fn("AdeIntegrationService.resolveReviewer")(function* (input: {
      readonly project: RepoBoundProject;
      readonly originatingBotId: string;
    }) {
      // `roleTag` is a free-form label (spec §2.1), so the designated-Reviewer
      // convention is a word match, not equality: "Reviewer", "reviewer", and
      // "Code Reviewer" are all the project's reviewer. Padding both sides makes
      // one LIKE cover the leading, trailing, and interior cases.
      const designated = yield* sql<{ readonly bot_id: string }>`
        SELECT bot_id FROM ade_bots
        WHERE project_id = ${input.project.projectId}
          AND archived_at IS NULL
          AND (' ' || LOWER(TRIM(role_tag)) || ' ') LIKE '% reviewer %'
          AND bot_id != ${input.originatingBotId}
        ORDER BY created_at ASC, rowid ASC
        LIMIT 1
      `.pipe(Effect.mapError(mapSql("resolveReviewer.designated")));
      const reviewer = designated[0];
      if (reviewer !== undefined) return reviewer.bot_id as BotId;

      // Fallback: the Second Mate reviews — unless they authored it.
      if (input.project.secondMateBotId === input.originatingBotId) return null;
      const secondMate = yield* sql<{ readonly bot_id: string }>`
        SELECT bot_id FROM ade_bots
        WHERE bot_id = ${input.project.secondMateBotId} AND archived_at IS NULL
      `.pipe(Effect.mapError(mapSql("resolveReviewer.secondMate")));
      return secondMate[0] === undefined ? null : (input.project.secondMateBotId as BotId);
    });

    const requestReview = Effect.fn("AdeIntegrationService.requestReview")(function* (input: {
      readonly project: RepoBoundProject;
      readonly candidate: CandidateRow;
      readonly reviewerBotId: BotId;
      readonly workspacePath: string;
    }) {
      const candidateId = input.candidate.integration_candidate_id;
      const changeIds = yield* Effect.orDie(decodeStringArray(input.candidate.change_ids_json));
      // Deterministic key: a restart mid-transition re-briefs the same reviewer
      // instead of queueing a second review (ADR §13.6).
      yield* assignments
        .createAssignment({
          requester: { _tag: "bot", botId: input.project.secondMateBotId },
          recipientBotId: input.reviewerBotId,
          instruction: [
            `Review integration candidate ${candidateId} for project ${input.project.projectId}.`,
            `Changes: ${changeIds.join(", ")}`,
            `Rebased workspace: ${input.workspacePath}`,
            `Checks are green. Approve or reject with feedback; a rejection bounces the change back to its author as a repair assignment.`,
          ].join("\n"),
          idempotencyKey: `ade-integration-review:${candidateId}`,
          declaredRisk: input.candidate.declared_risk as DeclaredRisk,
          projectId: input.project.projectId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning("ADE integration review assignment failed", { cause, candidateId }),
              null,
            ),
          ),
        );
      return yield* settle({
        candidateId,
        status: "awaiting-review",
        gate: "agent-review",
        reviewerBotId: input.reviewerBotId,
        workspacePath: input.workspacePath,
        leaseHolder: null,
        leaseExpiresAt: null,
      });
    });

    // -----------------------------------------------------------------------
    // The pass
    // -----------------------------------------------------------------------

    const runPass = Effect.fn("AdeIntegrationService.runPass")(function* (input: {
      readonly project: RepoBoundProject;
      readonly candidate: CandidateRow;
      readonly leaseHolder: string;
    }) {
      const { candidate, leaseHolder, project } = input;
      const candidateId = candidate.integration_candidate_id;
      const changeIds = yield* Effect.orDie(decodeStringArray(candidate.change_ids_json));
      const headRevision = changeIds[changeIds.length - 1] as string;
      const workspacePath = workspacePathFor(project.projectId, candidateId);
      const recordedGate = candidate.gate as IntegrationPolicy | null;
      const gate =
        recordedGate ??
        effectiveIntegrationGate(
          project.integrationPolicyDefault,
          candidate.declared_risk as DeclaredRisk,
        );

      // A recorded rejection settles without touching the repository at all.
      if (candidate.verdict === "rejected") {
        yield* bounce({
          project,
          candidate,
          reason: gate === "human-approval" ? "approval-denied" : "review-rejected",
          detail: candidate.verdict_detail ?? "The change was rejected without feedback.",
          workspacePath: candidate.workspace_path,
        });
        return advancedTo(candidateId, "bounced");
      }

      // 1. Explicit upstream sync (ADR §14.3) — remote truth before mutation.
      const sync = yield* repo.syncUpstream({
        repoPath: project.repoPath,
        remote: project.repoRemote,
      });
      if (sync.conflictDetail !== null) {
        yield* bounce({
          project,
          candidate,
          reason: "rebase-conflict",
          detail: `Upstream sync conflicted:\n${sync.conflictDetail}`,
          workspacePath: null,
        });
        return advancedTo(candidateId, "bounced");
      }
      yield* refreshLease(candidateId, leaseHolder);

      // 2. Converge on the durable commit point before redoing any work: if
      //    canonical already contains this head, a previous pass advanced it and
      //    died before writing the status. Re-rebasing here would surface as a
      //    conflict and bounce the author for an integrated change.
      const canonical = yield* repo.canonicalState({ repoPath: project.repoPath, headRevision });
      if (canonical.containsHead) {
        const outcome = yield* integrate({ project, candidate, gate, leaseHolder });
        return outcome._tag === "integrated"
          ? advancedTo(candidateId, "integrated")
          : ({ _tag: "busy" } as const);
      }

      // 3. Isolated workspace, rebased fresh onto the just-advanced canonical.
      const prepared = yield* repo.prepareCandidateWorkspace({
        repoPath: project.repoPath,
        workspacePath,
        workspaceName: workspaceNameFor(candidateId),
        changeIds,
      });
      // Record the workspace immediately so a crash still leaves a forensic
      // trail pointing at it.
      yield* settle({ candidateId, status: "running", workspacePath: prepared.workspacePath });
      yield* refreshLease(candidateId, leaseHolder);
      if (prepared.conflictDetail !== null) {
        yield* bounce({
          project,
          candidate,
          reason: "rebase-conflict",
          detail: `Rebase onto canonical conflicted:\n${prepared.conflictDetail}`,
          workspacePath: prepared.workspacePath,
        });
        return advancedTo(candidateId, "bounced");
      }

      // 4. Green checks are required at every gate level, including automatic —
      //    and including on the far side of an approval.
      const checks = yield* repo.runChecks({
        workspacePath: prepared.workspacePath,
        checkCommands: project.checkCommands,
      });
      yield* refreshLease(candidateId, leaseHolder);
      if (!checks.passed) {
        yield* bounce({
          project,
          candidate,
          reason: "checks-failed",
          detail: `Required checks failed:\n\n${renderCheckFailures(checks.failures)}`,
          workspacePath: prepared.workspacePath,
        });
        return advancedTo(candidateId, "bounced");
      }

      // 5. Apply the recorded verdict, or classify the gate for the first time.
      if (candidate.verdict === "approved") {
        const outcome = yield* integrate({ project, candidate, gate, leaseHolder });
        return outcome._tag === "integrated"
          ? advancedTo(candidateId, "integrated")
          : outcome._tag === "requeued"
            ? advancedTo(candidateId, "queued")
            : ({ _tag: "busy" } as const);
      }

      if (gate === "automatic") {
        const outcome = yield* integrate({ project, candidate, gate, leaseHolder });
        return outcome._tag === "integrated"
          ? advancedTo(candidateId, "integrated")
          : outcome._tag === "requeued"
            ? advancedTo(candidateId, "queued")
            : ({ _tag: "busy" } as const);
      }
      if (gate === "agent-review") {
        const reviewerBotId = yield* resolveReviewer({
          project,
          originatingBotId: candidate.originating_bot_id,
        });
        if (reviewerBotId !== null) {
          yield* requestReview({
            project,
            candidate,
            reviewerBotId,
            workspacePath: prepared.workspacePath,
          });
          return advancedTo(candidateId, "awaiting-review");
        }
        // No eligible reviewer (the author is the only candidate). Never
        // self-review; escalate to the captain rather than waving it through.
        yield* Effect.logInfo("ADE integration escalated to captain approval", {
          candidateId,
          reason: "no-eligible-reviewer",
        });
      }
      yield* settle({
        candidateId,
        status: "awaiting-approval",
        gate: "human-approval",
        reviewerBotId: null,
        workspacePath: prepared.workspacePath,
        leaseHolder: null,
        leaseExpiresAt: null,
      });
      // Parking is only real once the captain can see it: an approval that
      // waits without an inbox row is an assignment nobody will ever answer.
      yield* openApprovalItem({
        candidateId,
        projectId: project.projectId,
        originatingBotId: candidate.originating_bot_id,
      });
      return advancedTo(candidateId, "awaiting-approval");
    });

    const processQueueHead: AdeIntegrationServiceShape["processQueueHead"] = Effect.fn(
      "AdeIntegrationService.processQueueHead",
    )(function* (projectId: AdeProjectId) {
      const project = yield* requireRepoBoundProject(projectId);

      // A candidate parked on its gate holds the whole project queue, so the
      // next candidate is always rebased onto the just-advanced canonical.
      const parked = yield* sql<CandidateRow>`
        SELECT * FROM ade_integration_candidates
        WHERE project_id = ${projectId}
          AND status IN ('awaiting-review', 'awaiting-approval')
        ORDER BY created_at ASC, rowid ASC
        LIMIT 1
      `.pipe(Effect.mapError(mapSql("processQueueHead.parked")));
      const parkedRow = parked[0];
      if (parkedRow !== undefined) {
        return {
          _tag: "waiting",
          candidateId: parkedRow.integration_candidate_id as IntegrationCandidateId,
        } as const;
      }

      const leaseHolder = yield* uuid;
      const at = yield* nowIso;
      const expiresAt = yield* leaseExpiryIso;

      // Adopt a `running` row left by a dead pass — but only if its lease has
      // lapsed. Without the conditional claim two workers happily adopt the same
      // row and share one workspace directory.
      const adopted = yield* sql<CandidateRow>`
        UPDATE ade_integration_candidates
        SET lease_holder = ${leaseHolder}, lease_expires_at = ${expiresAt}, updated_at = ${at}
        WHERE integration_candidate_id = (
          SELECT integration_candidate_id FROM ade_integration_candidates
          WHERE project_id = ${projectId} AND status = 'running'
          ORDER BY created_at ASC, rowid ASC
          LIMIT 1
        )
          AND status = 'running'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ${at})
        RETURNING *
      `.pipe(Effect.mapError(mapSql("processQueueHead.adopt")));

      let head = adopted[0];
      if (head === undefined) {
        // Distinguish "nothing running" from "someone else holds it".
        const running = yield* sql<{ readonly integration_candidate_id: string }>`
          SELECT integration_candidate_id FROM ade_integration_candidates
          WHERE project_id = ${projectId} AND status = 'running'
          LIMIT 1
        `.pipe(Effect.mapError(mapSql("processQueueHead.running")));
        if (running.length > 0) return { _tag: "busy" } as const;

        const queued = yield* sql<CandidateRow>`
          SELECT * FROM ade_integration_candidates
          WHERE project_id = ${projectId} AND status = 'queued'
          ORDER BY created_at ASC, rowid ASC
          LIMIT 1
        `.pipe(Effect.mapError(mapSql("processQueueHead.queued")));
        const next = queued[0];
        if (next === undefined) return { _tag: "idle" } as const;
        // The partial unique index is the arbiter: a concurrent claim fails
        // here rather than producing a second running pass.
        const claimed = yield* sql<CandidateRow>`
          UPDATE ade_integration_candidates
          SET status = 'running', lease_holder = ${leaseHolder},
              lease_expires_at = ${expiresAt}, updated_at = ${at}
          WHERE integration_candidate_id = ${next.integration_candidate_id}
            AND status = 'queued'
          RETURNING *
        `.pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CandidateRow>)));
        const claimedRow = claimed[0];
        if (claimedRow === undefined) return { _tag: "busy" } as const;
        head = claimedRow;
      }

      const candidate = head;
      return yield* runPass({ project, candidate, leaseHolder }).pipe(
        Effect.catchTag("AdeIntegrationRepoError", (error) =>
          Effect.gen(function* () {
            // Mechanical failure: release the slot so the next sweep re-runs the
            // candidate from scratch (ADR §16.2). No bounce — the author did
            // nothing wrong. Only release what we still hold.
            const releasedAt = yield* nowIso;
            yield* sql`
              UPDATE ade_integration_candidates
              SET status = 'queued', lease_holder = NULL, lease_expires_at = NULL,
                  updated_at = ${releasedAt}
              WHERE integration_candidate_id = ${candidate.integration_candidate_id}
                AND status = 'running'
                AND lease_holder = ${leaseHolder}
            `.pipe(Effect.mapError(mapSql("processQueueHead.release")));
            yield* Effect.logWarning("ADE integration pass deferred", {
              candidateId: candidate.integration_candidate_id,
              detail: error.message,
            });
            return {
              _tag: "deferred",
              candidateId: candidate.integration_candidate_id as IntegrationCandidateId,
              detail: error.message,
            } as const;
          }),
        ),
      );
    });

    const runOnce: AdeIntegrationServiceShape["runOnce"] = Effect.fn(
      "AdeIntegrationService.runOnce",
    )(function* () {
      const rows = yield* sql<{ readonly project_id: string }>`
        SELECT DISTINCT project_id FROM ade_integration_candidates
        WHERE status IN ('queued', 'running')
        ORDER BY project_id
      `.pipe(Effect.mapError(mapSql("runOnce")));
      const projects: Array<AdeProjectId> = [];
      for (const row of rows) {
        const projectId = row.project_id as AdeProjectId;
        yield* processQueueHead(projectId).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning("ADE integration queue head failed", { cause, projectId }),
              {
                _tag: "idle",
              } as const,
            ),
          ),
        );
        projects.push(projectId);
      }
      return { projects };
    });

    // -----------------------------------------------------------------------
    // Verdicts
    // -----------------------------------------------------------------------

    /**
     * Record the verdict and take the running slot in one conditional update.
     * This is what makes the gate crash-safe: from here on the candidate is a
     * normal running candidate carrying a durable decision, so recovery and the
     * ordinary pass converge on it.
     */
    const claimForVerdict = Effect.fn("AdeIntegrationService.claimForVerdict")(function* (input: {
      readonly candidateId: string;
      readonly fromStatus: "awaiting-review" | "awaiting-approval";
      readonly verdict: IntegrationVerdict;
      readonly verdictByBotId: string | null;
      readonly verdictDetail: string | null;
      readonly leaseHolder: string;
      readonly reviewerBotId?: string;
    }) {
      const at = yield* nowIso;
      const expiresAt = yield* leaseExpiryIso;
      const rows = yield* sql<CandidateRow>`
        UPDATE ade_integration_candidates
        SET status = 'running',
            verdict = ${input.verdict},
            verdict_at = ${at},
            verdict_by_bot_id = ${input.verdictByBotId},
            verdict_detail = ${input.verdictDetail},
            lease_holder = ${input.leaseHolder},
            lease_expires_at = ${expiresAt},
            updated_at = ${at}
        WHERE integration_candidate_id = ${input.candidateId}
          AND status = ${input.fromStatus}
          AND (${input.reviewerBotId ?? null} IS NULL OR reviewer_bot_id = ${input.reviewerBotId ?? null})
        RETURNING *
      `.pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CandidateRow>)));
      const claimed = rows[0] ?? null;
      // The single conditional exit from `awaiting-approval`, so this is the
      // one place the durable Needs You item can be retired — no matter which
      // rendering (inbox, inline, or a later voice confirmation) produced the
      // verdict. Second callers lose the claim and resolve nothing.
      if (claimed !== null && input.fromStatus === "awaiting-approval") {
        yield* resolveApprovalItems(input.candidateId);
      }
      return claimed;
    });

    const applyVerdict = Effect.fn("AdeIntegrationService.applyVerdict")(function* (input: {
      readonly claimed: CandidateRow;
      readonly project: RepoBoundProject;
      readonly leaseHolder: string;
      readonly reason: IntegrationBounceReason;
    }) {
      const gate =
        (input.claimed.gate as IntegrationPolicy | null) ??
        effectiveIntegrationGate(
          input.project.integrationPolicyDefault,
          input.claimed.declared_risk as DeclaredRisk,
        );
      // The verdict is already durable, so a repository or repair-emission
      // failure hands the candidate back to the sweeper rather than failing the
      // caller's verdict submission.
      const deferToSweeper = (error: AdeIntegrationRepoError) =>
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* sql`
            UPDATE ade_integration_candidates
            SET status = 'queued', lease_holder = NULL, lease_expires_at = NULL, updated_at = ${at}
            WHERE integration_candidate_id = ${input.claimed.integration_candidate_id}
              AND status = 'running'
              AND lease_holder = ${input.leaseHolder}
          `.pipe(Effect.mapError(mapSql("applyVerdict.release")));
          yield* Effect.logWarning("ADE integration verdict deferred to the sweeper", {
            candidateId: input.claimed.integration_candidate_id,
            detail: error.message,
          });
          return { _tag: "requeued", detail: error.message } as const;
        });

      if (input.claimed.verdict === "rejected") {
        const bounced = yield* bounce({
          project: input.project,
          candidate: input.claimed,
          reason: input.reason,
          detail: input.claimed.verdict_detail ?? "The change was rejected without feedback.",
          workspacePath: input.claimed.workspace_path,
        }).pipe(
          Effect.catchTag("AdeIntegrationRepoError", (error) =>
            Effect.as(deferToSweeper(error), null),
          ),
        );
        if (bounced !== null) return bounced;
        const requeuedRows = yield* readCandidateRow(input.claimed.integration_candidate_id).pipe(
          Effect.mapError(mapSql("applyVerdict.reread")),
        );
        return requeuedRows[0] ?? input.claimed;
      }
      const outcome = yield* integrate({
        project: input.project,
        candidate: input.claimed,
        gate,
        leaseHolder: input.leaseHolder,
      }).pipe(Effect.catchTag("AdeIntegrationRepoError", deferToSweeper));
      if (outcome._tag === "integrated") return outcome.row;
      const rows = yield* readCandidateRow(input.claimed.integration_candidate_id).pipe(
        Effect.mapError(mapSql("applyVerdict.reread")),
      );
      return rows[0] ?? input.claimed;
    });

    const submitReview: AdeIntegrationServiceShape["submitReview"] = Effect.fn(
      "AdeIntegrationService.submitReview",
    )(function* (input: SubmitReviewInput) {
      const candidate = yield* requireCandidate(input.candidateId);
      if (candidate.status !== "awaiting-review") {
        return yield* new AdeIntegrationCandidateStateError({
          candidateId: input.candidateId,
          expected: "awaiting-review",
          actual: candidate.status,
        });
      }
      // Structural attribution still checks identity: the recorded reviewer is
      // the only one whose verdict counts, and it is never the author.
      if (
        candidate.reviewer_bot_id !== input.reviewerBotId ||
        candidate.originating_bot_id === input.reviewerBotId
      ) {
        return yield* new AdeIntegrationReviewerMismatchError({
          candidateId: input.candidateId,
          expectedReviewerBotId: candidate.reviewer_bot_id,
          actualReviewerBotId: input.reviewerBotId,
        });
      }
      const project = yield* requireRepoBoundProject(candidate.project_id as AdeProjectId);
      const leaseHolder = yield* uuid;
      const claimed = yield* claimForVerdict({
        candidateId: input.candidateId,
        fromStatus: "awaiting-review",
        verdict: input.decision === "approve" ? "approved" : "rejected",
        verdictByBotId: input.reviewerBotId,
        verdictDetail:
          input.feedback ??
          (input.decision === "reject"
            ? `Reviewer ${input.reviewerBotId} rejected the change without feedback.`
            : null),
        leaseHolder,
        reviewerBotId: input.reviewerBotId,
      });
      if (claimed === null) {
        return yield* new AdeIntegrationBusyError({
          projectId: project.projectId,
          candidateId: input.candidateId,
        });
      }
      const row = yield* applyVerdict({
        claimed,
        project,
        leaseHolder,
        reason: "review-rejected",
      });
      return yield* rowToCandidate(row);
    });

    const submitApproval: AdeIntegrationServiceShape["submitApproval"] = Effect.fn(
      "AdeIntegrationService.submitApproval",
    )(function* (input: SubmitApprovalInput) {
      const candidate = yield* requireCandidate(input.candidateId);
      if (candidate.status !== "awaiting-approval") {
        return yield* new AdeIntegrationCandidateStateError({
          candidateId: input.candidateId,
          expected: "awaiting-approval",
          actual: candidate.status,
        });
      }
      const project = yield* requireRepoBoundProject(candidate.project_id as AdeProjectId);
      const leaseHolder = yield* uuid;
      const claimed = yield* claimForVerdict({
        candidateId: input.candidateId,
        fromStatus: "awaiting-approval",
        verdict: input.decision === "approve" ? "approved" : "rejected",
        verdictByBotId: null,
        verdictDetail:
          input.note ?? (input.decision === "deny" ? "The captain denied this change." : null),
        leaseHolder,
      });
      if (claimed === null) {
        return yield* new AdeIntegrationBusyError({
          projectId: project.projectId,
          candidateId: input.candidateId,
        });
      }
      const row = yield* applyVerdict({
        claimed,
        project,
        leaseHolder,
        reason: "approval-denied",
      });
      return yield* rowToCandidate(row);
    });

    // -----------------------------------------------------------------------
    // Explicit operations & housekeeping
    // -----------------------------------------------------------------------

    const syncUpstream: AdeIntegrationServiceShape["syncUpstream"] = Effect.fn(
      "AdeIntegrationService.syncUpstream",
    )(function* (projectId: AdeProjectId) {
      const project = yield* requireRepoBoundProject(projectId);
      // ADE never rebases canonical under a running pass *or* under a candidate
      // parked on a gate: that candidate was rebased onto the current canonical
      // and its approval would otherwise try to move the bookmark backwards.
      const busyRows = yield* sql<CandidateRow>`
        SELECT * FROM ade_integration_candidates
        WHERE project_id = ${projectId}
          AND status IN ('running', 'awaiting-review', 'awaiting-approval')
        LIMIT 1
      `.pipe(Effect.mapError(mapSql("syncUpstream.busy")));
      const busy = busyRows[0];
      if (busy !== undefined) {
        return yield* new AdeIntegrationBusyError({
          projectId,
          candidateId: busy.integration_candidate_id,
        });
      }
      return yield* repo
        .syncUpstream({ repoPath: project.repoPath, remote: project.repoRemote })
        .pipe(
          Effect.map((result) => ({
            advanced: result.advanced,
            conflictDetail: result.conflictDetail,
          })),
          Effect.catchTag("AdeIntegrationRepoError", (error) =>
            Effect.succeed({ advanced: false, conflictDetail: error.message }),
          ),
        );
    });

    const cleanupCandidateWorkspace: AdeIntegrationServiceShape["cleanupCandidateWorkspace"] =
      Effect.fn("AdeIntegrationService.cleanupCandidateWorkspace")(function* (
        candidateId: IntegrationCandidateId,
      ) {
        const candidate = yield* requireCandidate(candidateId);
        if (candidate.workspace_path !== null) {
          const projectRows = yield* sql<{ readonly repo_path: string | null }>`
            SELECT repo_path FROM ade_projects WHERE project_id = ${candidate.project_id}
          `.pipe(Effect.mapError(mapSql("cleanupCandidateWorkspace.project")));
          const repoPath = projectRows[0]?.repo_path;
          if (repoPath !== undefined && repoPath !== null) {
            // `cleanupWorkspace` forgets the JJ workspace before removing the
            // directory, so a retained forensic workspace stops holding a
            // working-copy registration once it is reclaimed.
            yield* repo
              .cleanupWorkspace({
                repoPath,
                workspacePath: candidate.workspace_path,
                workspaceName: workspaceNameFor(candidateId),
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.as(
                    Effect.logWarning("ADE integration forensic cleanup failed", {
                      cause,
                      candidateId,
                    }),
                    undefined,
                  ),
                ),
              );
          }
        }
        const row = yield* settle({
          candidateId,
          status: candidate.status as IntegrationCandidateStatus,
          workspacePath: null,
        });
        return yield* rowToCandidate(row);
      });

    const sweepRetainedWorkspaces: AdeIntegrationServiceShape["sweepRetainedWorkspaces"] =
      Effect.fn("AdeIntegrationService.sweepRetainedWorkspaces")(function* () {
        const limits = yield* readLimits.pipe(Effect.mapError(mapSql("sweepRetainedWorkspaces")));
        const now = yield* DateTime.now;
        const cutoff = DateTime.formatIso(
          DateTime.subtractDuration(now, Duration.days(limits.integrationWorkspaceRetentionDays)),
        );
        const stale = yield* sql<{ readonly integration_candidate_id: string }>`
          SELECT integration_candidate_id FROM ade_integration_candidates
          WHERE status = 'bounced'
            AND workspace_path IS NOT NULL
            AND updated_at <= ${cutoff}
          ORDER BY updated_at
          LIMIT 50
        `.pipe(Effect.mapError(mapSql("sweepRetainedWorkspaces.select")));
        const cleaned: Array<IntegrationCandidateId> = [];
        for (const row of stale) {
          const candidateId = row.integration_candidate_id as IntegrationCandidateId;
          yield* cleanupCandidateWorkspace(candidateId).pipe(
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.logWarning("ADE integration retention sweep failed", { cause, candidateId }),
                null,
              ),
            ),
          );
          cleaned.push(candidateId);
        }
        if (cleaned.length > 0) {
          yield* Effect.log("ADE integration reclaimed retained workspaces", { cleaned });
        }
        return { cleaned };
      });

    const recoverRunningCandidates: AdeIntegrationServiceShape["recoverRunningCandidates"] =
      Effect.fn("AdeIntegrationService.recoverRunningCandidates")(function* () {
        const at = yield* nowIso;
        // No mid-pipeline resume: the head simply re-runs from scratch, with the
        // workspace reset from canonical on the next pass (ADR §16.2). Only
        // expired leases are reclaimed, so a live pass in another worker is
        // never yanked out from under itself.
        const rows = yield* sql<{ readonly integration_candidate_id: string }>`
          UPDATE ade_integration_candidates
          SET status = 'queued', lease_holder = NULL, lease_expires_at = NULL, updated_at = ${at}
          WHERE status = 'running'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ${at})
          RETURNING integration_candidate_id
        `.pipe(Effect.mapError(mapSql("recoverRunningCandidates")));
        const requeued = rows.map((row) => row.integration_candidate_id as IntegrationCandidateId);
        if (requeued.length > 0) {
          yield* Effect.log("ADE integration re-queued interrupted candidates", { requeued });
        }
        return { requeued };
      });

    return AdeIntegrationService.of({
      enqueueCandidate,
      getCandidate,
      listCandidates,
      processQueueHead,
      runOnce,
      submitReview,
      submitApproval,
      syncUpstream,
      cleanupCandidateWorkspace,
      sweepRetainedWorkspaces,
      recoverRunningCandidates,
    });
  });

// ---------------------------------------------------------------------------
// Service tag & layers
// ---------------------------------------------------------------------------

export class AdeIntegrationService extends Context.Service<
  AdeIntegrationService,
  AdeIntegrationServiceShape
>()("shuv2code/ade/AdeIntegrationService") {
  static readonly layerWith = (
    options: AdeIntegrationServiceOptions = {},
  ): Layer.Layer<
    AdeIntegrationService,
    never,
    SqlClient.SqlClient | AdeIntegrationRepoPort | AdeAssignmentEngine | Path.Path
  > => Layer.effect(AdeIntegrationService, make(options));

  static readonly layer = AdeIntegrationService.layerWith();

  /**
   * Background pass, mirroring the assignment sweeper: recover once at
   * activation (the restart re-run of ADR §16.2), then keep driving every
   * project's queue head and reclaiming expired forensic workspaces.
   */
  static readonly sweeperLive = (
    interval: Duration.Duration = ADE_INTEGRATION_SWEEP_INTERVAL_DEFAULT,
  ): Layer.Layer<never, never, AdeIntegrationService> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const service = yield* AdeIntegrationService;
        const guard = <A, E>(effect: Effect.Effect<A, E>, label: string) =>
          effect.pipe(
            Effect.catchCause((cause) => Effect.as(Effect.logWarning(label, { cause }), undefined)),
            Effect.catchDefect((defect) =>
              Effect.as(Effect.logWarning(label, { defect }), undefined),
            ),
          );
        yield* forkParked(
          Effect.gen(function* () {
            yield* guard(service.recoverRunningCandidates(), "ADE integration recovery failed");
            yield* Effect.repeat(
              Effect.gen(function* () {
                yield* guard(service.runOnce(), "ADE integration sweep failed");
                yield* guard(
                  service.sweepRetainedWorkspaces(),
                  "ADE integration retention sweep failed",
                );
              }),
              Schedule.spaced(interval),
            );
          }),
        );
      }),
    );
}

export interface AdeIntegrationServiceOptions {
  /** Root for per-candidate JJ workspaces; defaults to `~/.ade/workspaces`. */
  readonly workspaceRoot?: string;
  /** How long a claim on the running slot survives without a refresh. */
  readonly leaseTtl?: Duration.Duration;
}

export const ADE_INTEGRATION_SWEEP_INTERVAL_DEFAULT = Duration.seconds(15);

/**
 * Generous relative to the refresh cadence (every pipeline step) and short
 * enough that a killed process's candidates return to the queue promptly.
 */
export const ADE_INTEGRATION_LEASE_TTL_DEFAULT = Duration.minutes(2);
