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
 * Three invariants carry the design:
 *
 * 1. **One running candidate per project** is enforced twice — by
 *    `idx_ade_integration_candidates_one_running` (a lost claim surfaces as a
 *    constraint failure, not a double pass) and by the service refusing to
 *    start work while a candidate sits on a gate.
 * 2. **No per-step journal** (ADR §16.2). Nothing here records "which step we
 *    reached". Restart resets `running` rows to `queued` and the pass re-runs
 *    from scratch: upstream is re-synced, the workspace is destroyed and
 *    recreated from canonical, checks re-execute. Canonical advancement is the
 *    single durable commit point — it either happened or the candidate re-runs.
 *    `awaiting-review` / `awaiting-approval` are *parked*, not mid-pipeline, so
 *    a restart leaves them alone; the verdict they wait for is still coming.
 * 3. **Repair, never retry** (ADR §13.3, §7.2). A conflict, a red check, a
 *    rejection, or a denial bounces the candidate and emits one repair
 *    assignment to the originating bot under a deterministic idempotency key,
 *    so a restart mid-bounce cannot fan out duplicates.
 *
 * The service is backend-only; S12 renders the queue and S13 owns the captain
 * approval surface. Nothing here writes Needs You items or WS traffic.
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
} from "@shuv2code/contracts";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { forkParked } from "../serverActivation.ts";
import { AdeAssignmentEngine } from "./AdeAssignmentEngine.ts";
import { AdeIntegrationRepoPort } from "./AdeIntegrationRepoPort.ts";

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
    return `ADE project '${this.projectId}' is integrating candidate '${this.candidateId}'; retry the sync once it settles.`;
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
  /** False when `(projectId, idempotencyKey)` already existed. */
  readonly created: boolean;
}

export type ProcessQueueHeadOutcome =
  /** No queued or running candidate for this project. */
  | { readonly _tag: "idle" }
  /** A candidate is parked on its gate; the queue stays held (ADR §7.2). */
  | { readonly _tag: "waiting"; readonly candidateId: IntegrationCandidateId }
  /** Another pass holds the running slot (the partial unique index refused us). */
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

export type SubmitVerdictError =
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
  /** Restart recovery: running rows go back on the queue head (ADR §16.2). */
  readonly recoverRunningCandidates: () => Effect.Effect<RecoverOutcome, PersistenceSqlError>;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface CandidateRow {
  readonly integration_candidate_id: string;
  readonly project_id: string;
  readonly idempotency_key: string;
  readonly source_assignment_ids_json: string;
  readonly change_ids_json: string;
  readonly originating_bot_id: string;
  readonly declared_risk: string;
  readonly status: string;
  readonly gate: string | null;
  readonly reviewer_bot_id: string | null;
  readonly workspace_path: string | null;
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

const rowToCandidate = Effect.fn("AdeIntegrationService.rowToCandidate")(function* (
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
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
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
      const idempotencyKey =
        input.idempotencyKey ??
        (input.sourceAssignmentIds.length > 0
          ? input.sourceAssignmentIds.join("|")
          : input.changeIds.join("|"));

      const existing = yield* sql<CandidateRow>`
        SELECT * FROM ade_integration_candidates
        WHERE project_id = ${input.projectId} AND idempotency_key = ${idempotencyKey}
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
          source_assignment_ids_json, change_ids_json, originating_bot_id,
          declared_risk, status, gate, reviewer_bot_id, workspace_path,
          bounce_count, bounce_json, repair_assignment_id, created_at, updated_at
        ) VALUES (
          ${candidateId}, ${input.projectId}, ${idempotencyKey},
          ${sourceJson}, ${changesJson}, ${input.originatingBotId},
          ${input.declaredRisk ?? "normal"}, 'queued', NULL, NULL, NULL,
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
        WHERE project_id = ${input.projectId} AND idempotency_key = ${idempotencyKey}
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
        ORDER BY created_at, integration_candidate_id
      `.pipe(Effect.mapError(mapSql("listCandidates")));
      const filtered = rows.filter(
        (row) =>
          statuses === undefined || statuses.includes(row.status as IntegrationCandidateStatus),
      );
      return yield* Effect.forEach(filtered, rowToCandidate);
    });

    // -----------------------------------------------------------------------
    // Verdict transitions
    // -----------------------------------------------------------------------

    const settle = Effect.fn("AdeIntegrationService.settle")(function* (input: {
      readonly candidateId: string;
      readonly status: IntegrationCandidateStatus;
      readonly gate?: IntegrationPolicy | null;
      readonly reviewerBotId?: BotId | null;
      readonly workspacePath?: string | null;
      readonly bounce?: IntegrationBounce | null;
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

    /**
     * A bounce is terminal for the candidate and emits exactly one repair
     * assignment under a candidate-scoped idempotency key, so a crash between
     * the status write and the assignment write cannot fan out duplicates on
     * the next pass (ADR §7.2, §13.3, §13.6). The workspace is deliberately
     * retained for forensics (ADR §14.4).
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
      const row = yield* settle({
        candidateId: input.candidate.integration_candidate_id,
        status: "bounced",
        ...(input.workspacePath !== null ? { workspacePath: input.workspacePath } : {}),
        bounce: { reason: input.reason, detail, at },
        bumpBounceCount: true,
      });

      const changeIds = yield* Effect.orDie(decodeStringArray(row.change_ids_json));
      const sourceIds = yield* Effect.orDie(decodeStringArray(row.source_assignment_ids_json));
      const instruction = [
        `Integration bounced this change back to you (${input.reason}).`,
        ``,
        `Project: ${input.project.projectId}`,
        `Candidate: ${row.integration_candidate_id}`,
        `Changes: ${changeIds.join(", ")}`,
        ...(row.workspace_path !== null ? [`Retained workspace: ${row.workspace_path}`] : []),
        ``,
        detail,
        ``,
        `Fix the change and submit a new integration candidate; this is a new assignment, not a retry.`,
      ].join("\n");

      // A repair that cannot be created (author archived/deleted, queue full)
      // must not strand the bounce itself — the candidate is already terminal
      // and the failure is logged for the Second Mate.
      const repair = yield* assignments
        .createAssignment({
          requester: { _tag: "bot", botId: input.project.secondMateBotId },
          recipientBotId: row.originating_bot_id as BotId,
          instruction,
          idempotencyKey: `ade-integration-repair:${row.integration_candidate_id}`,
          declaredRisk: row.declared_risk as DeclaredRisk,
          projectId: input.project.projectId,
          parentAssignmentId: (sourceIds[0] as AssignmentId | undefined) ?? null,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning("ADE integration repair assignment failed", {
                cause,
                candidateId: row.integration_candidate_id,
              }),
              null,
            ),
          ),
        );

      if (repair !== null) {
        yield* sql`
          UPDATE ade_integration_candidates
          SET repair_assignment_id = ${repair.assignment.id}
          WHERE integration_candidate_id = ${row.integration_candidate_id}
        `.pipe(Effect.mapError(mapSql("bounce.recordRepair")));
      }

      // Repeated bounces on the same change set notify the Second Mate, who
      // may reroute or escalate. No hard bounce cap in V1 (ADR §7.2).
      const priorBounces = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ade_integration_candidates
        WHERE project_id = ${input.project.projectId}
          AND status = 'bounced'
          AND change_ids_json = ${row.change_ids_json}
          AND integration_candidate_id != ${row.integration_candidate_id}
      `.pipe(Effect.mapError(mapSql("bounce.priorBounces")));
      const priorCount = priorBounces[0]?.n ?? 0;
      if (priorCount > 0 && input.project.secondMateBotId !== row.originating_bot_id) {
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
            idempotencyKey: `ade-integration-bounce-notice:${row.integration_candidate_id}`,
            declaredRisk: "normal",
            projectId: input.project.projectId,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.logWarning("ADE integration bounce notice failed", {
                  cause,
                  candidateId: row.integration_candidate_id,
                }),
                null,
              ),
            ),
          );
      }

      return yield* rowToCandidate(
        (yield* readCandidateRow(row.integration_candidate_id).pipe(
          Effect.mapError(mapSql("bounce.reread")),
        ))[0] ?? row,
      );
    });

    /**
     * Canonical advancement — the single durable commit point (ADR §16.2). The
     * workspace is cleaned up only after canonical moved; a cleanup failure is
     * logged rather than un-integrating a landed change.
     */
    const integrate = Effect.fn("AdeIntegrationService.integrate")(function* (input: {
      readonly project: RepoBoundProject;
      readonly candidate: CandidateRow;
      readonly gate: IntegrationPolicy;
    }) {
      const changeIds = yield* Effect.orDie(decodeStringArray(input.candidate.change_ids_json));
      const headRevision = changeIds[changeIds.length - 1] as string;
      const candidateId = input.candidate.integration_candidate_id;
      const advanced = yield* repo
        .advanceCanonical({ repoPath: input.project.repoPath, headRevision })
        .pipe(Effect.map((result) => result.canonicalCommitId));

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
              Effect.logWarning("ADE integration workspace cleanup failed", {
                cause,
                candidateId,
              }),
              undefined,
            ),
          ),
        );

      const row = yield* settle({
        candidateId,
        status: "integrated",
        gate: input.gate,
        workspacePath: null,
      });
      yield* Effect.log("ADE integration advanced canonical", {
        candidateId,
        projectId: input.project.projectId,
        canonicalCommitId: advanced,
      });
      return row;
    });

    // -----------------------------------------------------------------------
    // Reviewer routing (ADR §7.2)
    // -----------------------------------------------------------------------

    const resolveReviewer = Effect.fn("AdeIntegrationService.resolveReviewer")(function* (input: {
      readonly project: RepoBoundProject;
      readonly originatingBotId: string;
    }) {
      const designated = yield* sql<{ readonly bot_id: string }>`
        SELECT bot_id FROM ade_bots
        WHERE project_id = ${input.project.projectId}
          AND archived_at IS NULL
          AND role_tag = 'Reviewer'
          AND bot_id != ${input.originatingBotId}
        ORDER BY created_at, bot_id
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
              Effect.logWarning("ADE integration review assignment failed", {
                cause,
                candidateId,
              }),
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
      });
    });

    // -----------------------------------------------------------------------
    // The pass
    // -----------------------------------------------------------------------

    const runPass = Effect.fn("AdeIntegrationService.runPass")(function* (input: {
      readonly project: RepoBoundProject;
      readonly candidate: CandidateRow;
    }) {
      const { candidate, project } = input;
      const candidateId = candidate.integration_candidate_id;
      const changeIds = yield* Effect.orDie(decodeStringArray(candidate.change_ids_json));
      const workspacePath = workspacePathFor(project.projectId, candidateId);

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

      // 2. Isolated workspace, rebased fresh onto the just-advanced canonical.
      const prepared = yield* repo.prepareCandidateWorkspace({
        repoPath: project.repoPath,
        workspacePath,
        workspaceName: workspaceNameFor(candidateId),
        changeIds,
      });
      // Record the workspace immediately so a crash still leaves a forensic
      // trail pointing at it.
      yield* settle({ candidateId, status: "running", workspacePath: prepared.workspacePath });
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

      // 3. Green checks are required at every gate level, including automatic.
      const checks = yield* repo.runChecks({
        workspacePath: prepared.workspacePath,
        checkCommands: project.checkCommands,
      });
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

      // 4. Gate.
      const gate = effectiveIntegrationGate(
        project.integrationPolicyDefault,
        candidate.declared_risk as DeclaredRisk,
      );
      if (gate === "automatic") {
        yield* integrate({ project, candidate, gate });
        return advancedTo(candidateId, "integrated");
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
        yield* settle({
          candidateId,
          status: "awaiting-approval",
          gate: "human-approval",
          reviewerBotId: null,
          workspacePath: prepared.workspacePath,
        });
        return advancedTo(candidateId, "awaiting-approval");
      }
      yield* settle({
        candidateId,
        status: "awaiting-approval",
        gate: "human-approval",
        reviewerBotId: null,
        workspacePath: prepared.workspacePath,
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
        ORDER BY created_at, integration_candidate_id
        LIMIT 1
      `.pipe(Effect.mapError(mapSql("processQueueHead.parked")));
      const parkedRow = parked[0];
      if (parkedRow !== undefined) {
        return {
          _tag: "waiting",
          candidateId: parkedRow.integration_candidate_id as IntegrationCandidateId,
        } as const;
      }

      // Adopt a `running` row left by a crashed pass before claiming new work:
      // converge, then act.
      const running = yield* sql<CandidateRow>`
        SELECT * FROM ade_integration_candidates
        WHERE project_id = ${projectId} AND status = 'running'
        ORDER BY created_at, integration_candidate_id
        LIMIT 1
      `.pipe(Effect.mapError(mapSql("processQueueHead.running")));

      let head = running[0];
      if (head === undefined) {
        const queued = yield* sql<CandidateRow>`
          SELECT * FROM ade_integration_candidates
          WHERE project_id = ${projectId} AND status = 'queued'
          ORDER BY created_at, integration_candidate_id
          LIMIT 1
        `.pipe(Effect.mapError(mapSql("processQueueHead.queued")));
        const next = queued[0];
        if (next === undefined) return { _tag: "idle" } as const;
        const at = yield* nowIso;
        // The partial unique index is the real arbiter: a concurrent claim
        // fails here rather than producing a second running pass.
        const claimed = yield* sql<CandidateRow>`
          UPDATE ade_integration_candidates
          SET status = 'running', updated_at = ${at}
          WHERE integration_candidate_id = ${next.integration_candidate_id}
            AND status = 'queued'
          RETURNING *
        `.pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CandidateRow>)));
        const claimedRow = claimed[0];
        if (claimedRow === undefined) return { _tag: "busy" } as const;
        head = claimedRow;
      }

      const candidate = head;
      return yield* runPass({ project, candidate }).pipe(
        Effect.catchTag("AdeIntegrationRepoError", (error) =>
          Effect.gen(function* () {
            // Mechanical failure: leave the candidate on the queue head so the
            // next sweep re-runs it from scratch (ADR §16.2). No bounce — the
            // author did nothing wrong.
            const at = yield* nowIso;
            yield* sql`
              UPDATE ade_integration_candidates
              SET status = 'queued', updated_at = ${at}
              WHERE integration_candidate_id = ${candidate.integration_candidate_id}
                AND status = 'running'
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
              { _tag: "idle" } as const,
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
      if (input.decision === "approve") {
        const row = yield* integrate({ project, candidate, gate: "agent-review" }).pipe(
          Effect.catchTag("AdeIntegrationRepoError", (error) =>
            // Canonical did not move; park the candidate back on review so the
            // approval can be re-submitted once the repo is operable.
            Effect.as(
              Effect.logWarning("ADE integration approval could not advance canonical", {
                candidateId: input.candidateId,
                detail: error.message,
              }),
              candidate,
            ),
          ),
        );
        return yield* rowToCandidate(row);
      }
      return yield* bounce({
        project,
        candidate,
        reason: "review-rejected",
        detail:
          input.feedback ?? `Reviewer ${input.reviewerBotId} rejected the change without feedback.`,
        workspacePath: candidate.workspace_path,
      });
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
      if (input.decision === "approve") {
        const row = yield* integrate({ project, candidate, gate: "human-approval" }).pipe(
          Effect.catchTag("AdeIntegrationRepoError", (error) =>
            Effect.as(
              Effect.logWarning("ADE integration approval could not advance canonical", {
                candidateId: input.candidateId,
                detail: error.message,
              }),
              candidate,
            ),
          ),
        );
        return yield* rowToCandidate(row);
      }
      return yield* bounce({
        project,
        candidate,
        reason: "approval-denied",
        detail: input.note ?? "The captain denied this change.",
        workspacePath: candidate.workspace_path,
      });
    });

    const syncUpstream: AdeIntegrationServiceShape["syncUpstream"] = Effect.fn(
      "AdeIntegrationService.syncUpstream",
    )(function* (projectId: AdeProjectId) {
      const project = yield* requireRepoBoundProject(projectId);
      const running = yield* sql<CandidateRow>`
        SELECT * FROM ade_integration_candidates
        WHERE project_id = ${projectId} AND status = 'running'
        LIMIT 1
      `.pipe(Effect.mapError(mapSql("syncUpstream.running")));
      const busy = running[0];
      if (busy !== undefined) {
        // ADE never rebases under a running pass (ADR §14.3).
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

    const recoverRunningCandidates: AdeIntegrationServiceShape["recoverRunningCandidates"] =
      Effect.fn("AdeIntegrationService.recoverRunningCandidates")(function* () {
        const at = yield* nowIso;
        // No mid-pipeline resume: the head simply re-runs from scratch, with
        // the workspace reset from canonical on the next pass (ADR §16.2).
        const rows = yield* sql<{ readonly integration_candidate_id: string }>`
          UPDATE ade_integration_candidates
          SET status = 'queued', updated_at = ${at}
          WHERE status = 'running'
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
   * project's queue head.
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
              guard(service.runOnce(), "ADE integration sweep failed"),
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
}

export const ADE_INTEGRATION_SWEEP_INTERVAL_DEFAULT = Duration.seconds(15);
