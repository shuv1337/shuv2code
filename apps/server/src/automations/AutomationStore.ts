import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  AUTOMATION_SUMMARY_PREVIEW_CODE_POINTS,
  AutomationCreateInput,
  AutomationConcurrencyPolicy,
  AutomationCronExpression,
  AutomationError,
  AutomationId,
  AutomationListCursor,
  AutomationListInput,
  AutomationListResult,
  AutomationModelPreview,
  AutomationName,
  AutomationPrompt,
  AutomationPromptPreview,
  AutomationRun,
  AutomationRunId,
  AutomationTimeZone,
  AutomationUpdateInput,
  ModelSelection,
  NonNegativeInt,
  PositiveInt,
  ProviderInteractionMode,
  ProviderInstanceId,
  ProjectAutomation,
  ProjectAutomationSummary,
  ProjectId,
  RuntimeMode,
  ThreadId,
  type AutomationRunStatus,
  type AutomationRunTrigger,
} from "@shuv2code/contracts";

import { nextAutomationRunAt, parseAutomationSchedule } from "./AutomationSchedule.ts";

const ModelSelectionJson = Schema.fromJsonString(ModelSelection);
const encodeModelSelection = Schema.encodeSync(ModelSelectionJson);

const AutomationDbRow = Schema.Struct({
  id: AutomationId,
  projectId: ProjectId,
  name: AutomationName,
  prompt: AutomationPrompt,
  enabled: Schema.Number,
  cronExpression: AutomationCronExpression,
  timeZone: AutomationTimeZone,
  modelSelection: ModelSelectionJson,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  concurrencyPolicy: AutomationConcurrencyPolicy,
  nextRunAt: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const AutomationRunDbRow = AutomationRun;

const AutomationSummaryDbRow = Schema.Struct({
  id: AutomationId,
  projectId: ProjectId,
  name: AutomationName,
  promptPreview: AutomationPromptPreview,
  promptLength: NonNegativeInt,
  enabled: Schema.Number,
  cronExpression: AutomationCronExpression,
  timeZone: AutomationTimeZone,
  modelInstanceId: ProviderInstanceId,
  modelPreview: AutomationModelPreview,
  modelLength: NonNegativeInt,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  concurrencyPolicy: AutomationConcurrencyPolicy,
  nextRunAt: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const AutomationCursorProjectKey = Schema.String.check(
  Schema.isMinLength(43),
  Schema.isMaxLength(43),
);
const AutomationCursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  projectKey: AutomationCursorProjectKey,
  enabled: Schema.NullOr(Schema.Boolean),
  createdAt: Schema.String,
  automationId: AutomationId,
});
const AutomationCursorJson = Schema.fromJsonString(AutomationCursorPayload);
const encodeAutomationCursorJson = Schema.encodeSync(AutomationCursorJson);
const decodeAutomationCursorJson = Schema.decodeUnknownEffect(AutomationCursorJson);

type AutomationCursorPayload = typeof AutomationCursorPayload.Type;

const automationColumns = `
  automation_id AS "id",
  project_id AS "projectId",
  name,
  prompt,
  enabled,
  cron_expression AS "cronExpression",
  time_zone AS "timeZone",
  model_selection_json AS "modelSelection",
  runtime_mode AS "runtimeMode",
  interaction_mode AS "interactionMode",
  concurrency_policy AS "concurrencyPolicy",
  next_run_at AS "nextRunAt",
  last_run_at AS "lastRunAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const automationSummaryColumns = `
  automation_id AS "id",
  project_id AS "projectId",
  name,
  substr(prompt, 1, ${AUTOMATION_SUMMARY_PREVIEW_CODE_POINTS}) AS "promptPreview",
  length(prompt) AS "promptLength",
  enabled,
  cron_expression AS "cronExpression",
  time_zone AS "timeZone",
  json_extract(model_selection_json, '$.instanceId') AS "modelInstanceId",
  substr(
    CAST(json_extract(model_selection_json, '$.model') AS TEXT),
    1,
    ${AUTOMATION_SUMMARY_PREVIEW_CODE_POINTS}
  ) AS "modelPreview",
  length(CAST(json_extract(model_selection_json, '$.model') AS TEXT)) AS "modelLength",
  runtime_mode AS "runtimeMode",
  interaction_mode AS "interactionMode",
  concurrency_policy AS "concurrencyPolicy",
  next_run_at AS "nextRunAt",
  last_run_at AS "lastRunAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const runColumns = `
  run_id AS "id",
  automation_id AS "automationId",
  project_id AS "projectId",
  trigger,
  status,
  thread_id AS "threadId",
  scheduled_for AS "scheduledFor",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  error
`;

function persistenceError(operation: string, cause: unknown): AutomationError {
  return new AutomationError({
    reason: "persistence_failed",
    message: `${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });
}

const isAutomationError = Schema.is(AutomationError);

function toAutomation(row: typeof AutomationDbRow.Type): ProjectAutomation {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    cronExpression: row.cronExpression,
    timeZone: row.timeZone,
    modelSelection: row.modelSelection,
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    concurrencyPolicy: row.concurrencyPolicy,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAutomationSummary(row: typeof AutomationSummaryDbRow.Type): ProjectAutomationSummary {
  return {
    ...row,
    enabled: row.enabled === 1,
  };
}

function encodeAutomationCursor(payload: AutomationCursorPayload): AutomationListCursor {
  return AutomationListCursor.make(
    Buffer.from(encodeAutomationCursorJson(payload)).toString("base64url"),
  );
}

const invalidAutomationCursor = () =>
  new AutomationError({ reason: "invalid_cursor", message: "Invalid automation cursor." });

const decodeAutomationCursor = Effect.fn("AutomationStore.decodeAutomationCursor")(function* (
  cursor: AutomationListCursor,
): Effect.fn.Return<AutomationCursorPayload, AutomationError> {
  const decoded = yield* Effect.try({
    try: () => Buffer.from(cursor, "base64url").toString("utf8"),
    catch: invalidAutomationCursor,
  });
  return yield* decodeAutomationCursorJson(decoded).pipe(Effect.mapError(invalidAutomationCursor));
});

export interface DueAutomation {
  readonly automation: ProjectAutomation;
  readonly scheduledFor: string;
  readonly run: AutomationRun;
}

interface CreateRunInput {
  readonly automation: ProjectAutomation;
  readonly trigger: AutomationRunTrigger;
  readonly scheduledFor: string;
  readonly status: AutomationRunStatus;
  readonly threadId: ThreadId | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly error: string | null;
}

export type AutomationDeleteOutcome = "deleted" | "active" | "not_found";

export class AutomationStore extends Context.Service<
  AutomationStore,
  {
    readonly list: (
      input: AutomationListInput,
    ) => Effect.Effect<AutomationListResult, AutomationError>;
    readonly get: (
      automationId: AutomationId,
    ) => Effect.Effect<Option.Option<ProjectAutomation>, AutomationError>;
    readonly create: (
      input: AutomationCreateInput,
    ) => Effect.Effect<ProjectAutomation, AutomationError>;
    readonly update: (
      input: AutomationUpdateInput,
    ) => Effect.Effect<ProjectAutomation, AutomationError>;
    readonly delete: (
      automationId: AutomationId,
    ) => Effect.Effect<AutomationDeleteOutcome, AutomationError>;
    readonly claimDue: (
      now: string,
    ) => Effect.Effect<ReadonlyArray<DueAutomation>, AutomationError>;
    readonly admitRun: (input: {
      readonly automation: ProjectAutomation;
      readonly trigger: AutomationRunTrigger;
      readonly scheduledFor: string;
    }) => Effect.Effect<AutomationRun, AutomationError>;
    readonly setLastRunAt: (
      automationId: AutomationId,
      at: string,
    ) => Effect.Effect<void, AutomationError>;
    readonly updateRun: (input: {
      readonly runId: AutomationRunId;
      readonly status: AutomationRunStatus;
      readonly threadId?: ThreadId | null;
      readonly startedAt?: string | null;
      readonly completedAt?: string | null;
      readonly error?: string | null;
    }) => Effect.Effect<AutomationRun, AutomationError>;
    readonly listRuns: (
      automationId: AutomationId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationError>;
    readonly listActiveRuns: () => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationError>;
    readonly hasActiveRun: (automationId: AutomationId) => Effect.Effect<boolean, AutomationError>;
  }
>()("@shuv2code/automations/AutomationStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const cursorProjectKey = Effect.fn("AutomationStore.cursorProjectKey")(function* (
    projectId: ProjectId,
  ) {
    const digest = yield* crypto
      .digest("SHA-256", Buffer.from(projectId, "utf8"))
      .pipe(
        Effect.mapError((cause) => persistenceError("AutomationStore.cursorProjectKey", cause)),
      );
    return Buffer.from(digest).toString("base64url");
  });

  const getRows = SqlSchema.findAll({
    Request: Schema.Struct({ automationId: AutomationId }),
    Result: AutomationDbRow,
    execute: ({ automationId }) =>
      sql.unsafe(`SELECT ${automationColumns} FROM project_automations WHERE automation_id = ?`, [
        automationId,
      ]),
  });

  const listSummaryRows = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      enabled: Schema.NullOr(Schema.Number),
      cursorCreatedAt: Schema.NullOr(Schema.String),
      cursorAutomationId: Schema.NullOr(AutomationId),
      limit: PositiveInt,
    }),
    Result: AutomationSummaryDbRow,
    execute: ({ projectId, enabled, cursorCreatedAt, cursorAutomationId, limit }) => {
      const clauses = ["project_id = ?"];
      const parameters: Array<string | number> = [projectId];
      if (enabled !== null) {
        clauses.push("enabled = ?");
        parameters.push(enabled);
      }
      if (cursorCreatedAt !== null && cursorAutomationId !== null) {
        clauses.push("(created_at > ? OR (created_at = ? AND automation_id > ?))");
        parameters.push(cursorCreatedAt, cursorCreatedAt, cursorAutomationId);
      }
      parameters.push(limit);
      return sql.unsafe(
        `SELECT ${automationSummaryColumns} FROM project_automations WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, automation_id ASC LIMIT ?`,
        parameters,
      );
    },
  });

  const upsert = (automation: ProjectAutomation) =>
    sql`
      INSERT INTO project_automations (
        automation_id, project_id, name, prompt, enabled, cron_expression, time_zone,
        model_selection_json, runtime_mode, interaction_mode, concurrency_policy,
        next_run_at, last_run_at, created_at, updated_at
      ) VALUES (
        ${automation.id}, ${automation.projectId}, ${automation.name}, ${automation.prompt},
        ${automation.enabled ? 1 : 0}, ${automation.cronExpression}, ${automation.timeZone},
        ${encodeModelSelection(automation.modelSelection)}, ${automation.runtimeMode},
        ${automation.interactionMode}, ${automation.concurrencyPolicy}, ${automation.nextRunAt},
        ${automation.lastRunAt}, ${automation.createdAt}, ${automation.updatedAt}
      )
      ON CONFLICT (automation_id) DO UPDATE SET
        name = excluded.name,
        prompt = excluded.prompt,
        enabled = excluded.enabled,
        cron_expression = excluded.cron_expression,
        time_zone = excluded.time_zone,
        model_selection_json = excluded.model_selection_json,
        runtime_mode = excluded.runtime_mode,
        interaction_mode = excluded.interaction_mode,
        concurrency_policy = excluded.concurrency_policy,
        next_run_at = excluded.next_run_at,
        last_run_at = excluded.last_run_at,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.as(automation),
      Effect.mapError((cause) => persistenceError("AutomationStore.upsert", cause)),
    );

  const list: AutomationStore["Service"]["list"] = Effect.fn("AutomationStore.list")(
    function* (input) {
      const limit = input.limit ?? 50;
      const cursor =
        input.cursor === undefined ? null : yield* decodeAutomationCursor(input.cursor);
      const projectKey = yield* cursorProjectKey(input.projectId);
      if (
        cursor !== null &&
        (cursor.projectKey !== projectKey ||
          (input.enabled !== undefined && cursor.enabled !== input.enabled))
      ) {
        return yield* invalidAutomationCursor();
      }
      const enabled = cursor === null ? (input.enabled ?? null) : cursor.enabled;
      const rows = yield* listSummaryRows({
        projectId: input.projectId,
        enabled: enabled === null ? null : enabled ? 1 : 0,
        cursorCreatedAt: cursor?.createdAt ?? null,
        cursorAutomationId: cursor?.automationId ?? null,
        limit: limit + 1,
      }).pipe(Effect.mapError((cause) => persistenceError("AutomationStore.list", cause)));
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        automations: page.map(toAutomationSummary),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeAutomationCursor({
                version: 1,
                projectKey,
                enabled,
                createdAt: last.createdAt,
                automationId: last.id,
              })
            : null,
      };
    },
  );

  const get: AutomationStore["Service"]["get"] = (automationId) =>
    getRows({ automationId }).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toAutomation))),
      Effect.mapError((cause) => persistenceError("AutomationStore.get", cause)),
    );

  const create: AutomationStore["Service"]["create"] = Effect.fn("AutomationStore.create")(
    function* (input) {
      const parsed = parseAutomationSchedule(input);
      if (!parsed.ok) {
        return yield* new AutomationError({
          reason: "invalid_schedule",
          message: parsed.error,
        });
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const id = AutomationId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => persistenceError("AutomationStore.create:id", cause)),
        ),
      );
      const automation: ProjectAutomation = {
        id,
        ...input,
        nextRunAt: input.enabled ? nextAutomationRunAt(input, now) : null,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      };
      return yield* upsert(automation);
    },
  );

  const update: AutomationStore["Service"]["update"] = Effect.fn("AutomationStore.update")(
    function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* get(input.automationId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new AutomationError({
                        reason: "not_found",
                        message: "Automation not found.",
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            );
            const now = DateTime.formatIso(yield* DateTime.now);
            const merged: ProjectAutomation = {
              ...existing,
              name: input.name ?? existing.name,
              prompt: input.prompt ?? existing.prompt,
              enabled: input.enabled ?? existing.enabled,
              cronExpression: input.cronExpression ?? existing.cronExpression,
              timeZone: input.timeZone ?? existing.timeZone,
              modelSelection: input.modelSelection ?? existing.modelSelection,
              runtimeMode: input.runtimeMode ?? existing.runtimeMode,
              interactionMode: input.interactionMode ?? existing.interactionMode,
              concurrencyPolicy: input.concurrencyPolicy ?? existing.concurrencyPolicy,
            };
            const parsed = parseAutomationSchedule(merged);
            if (!parsed.ok) {
              return yield* new AutomationError({
                reason: "invalid_schedule",
                message: parsed.error,
              });
            }
            const scheduleChanged =
              input.cronExpression !== undefined ||
              input.timeZone !== undefined ||
              input.enabled !== undefined;
            const updated: ProjectAutomation = {
              ...merged,
              nextRunAt: !merged.enabled
                ? null
                : scheduleChanged
                  ? nextAutomationRunAt(merged, now)
                  : existing.nextRunAt,
              updatedAt: now,
            };
            const rows = yield* sql`
              UPDATE project_automations SET
                name = ${updated.name},
                prompt = ${updated.prompt},
                enabled = ${updated.enabled ? 1 : 0},
                cron_expression = ${updated.cronExpression},
                time_zone = ${updated.timeZone},
                model_selection_json = ${encodeModelSelection(updated.modelSelection)},
                runtime_mode = ${updated.runtimeMode},
                interaction_mode = ${updated.interactionMode},
                concurrency_policy = ${updated.concurrencyPolicy},
                next_run_at = ${updated.nextRunAt},
                updated_at = ${updated.updatedAt}
              WHERE automation_id = ${updated.id}
              RETURNING automation_id
            `;
            if (rows.length === 0) {
              return yield* new AutomationError({
                reason: "not_found",
                message: "Automation not found.",
              });
            }
            return updated;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isAutomationError(cause) ? cause : persistenceError("AutomationStore.update", cause),
          ),
        );
    },
  );

  const deleteAutomation: AutomationStore["Service"]["delete"] = (automationId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const deleted = yield* sql`
            DELETE FROM project_automations
            WHERE automation_id = ${automationId}
              AND NOT EXISTS (
                SELECT 1 FROM automation_runs
                WHERE automation_id = ${automationId}
                  AND status IN ('queued', 'running')
              )
            RETURNING automation_id
          `;
          if (deleted.length > 0) return "deleted" as const;

          const existing = yield* sql`
            SELECT automation_id FROM project_automations WHERE automation_id = ${automationId}
          `;
          return existing.length > 0 ? ("active" as const) : ("not_found" as const);
        }),
      )
      .pipe(Effect.mapError((cause) => persistenceError("AutomationStore.delete", cause)));

  const claimDue: AutomationStore["Service"]["claimDue"] = Effect.fn("AutomationStore.claimDue")(
    function* (now) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* SqlSchema.findAll({
              Request: Schema.Void,
              Result: AutomationDbRow,
              execute: () =>
                sql.unsafe(
                  `SELECT ${automationColumns}
                   FROM project_automations
                   WHERE enabled = 1
                     AND next_run_at IS NOT NULL
                     AND next_run_at <= ?
                     AND EXISTS (
                       SELECT 1 FROM projection_projects
                       WHERE projection_projects.project_id = project_automations.project_id
                         AND projection_projects.deleted_at IS NULL
                     )
                   ORDER BY next_run_at ASC, automation_id ASC`,
                  [now],
                ),
            })();

            const claimed: Array<DueAutomation> = [];
            for (const automation of rows.map(toAutomation)) {
              const scheduledFor = automation.nextRunAt!;
              const nextRunAt = nextAutomationRunAt(automation, now);
              const updated = yield* sql`
                UPDATE project_automations
                SET next_run_at = ${nextRunAt}, updated_at = ${now}
                WHERE automation_id = ${automation.id}
                  AND enabled = 1
                  AND next_run_at = ${scheduledFor}
                RETURNING automation_id
              `;
              if (updated.length === 0) continue;

              const claimedAutomation = { ...automation, nextRunAt };
              const run = yield* admitRunInTransaction({
                automation: claimedAutomation,
                trigger: "scheduled",
                scheduledFor,
              });
              claimed.push({ automation: claimedAutomation, scheduledFor, run });
            }
            return claimed;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isAutomationError(cause) ? cause : persistenceError("AutomationStore.claimDue", cause),
          ),
        );
    },
  );

  const setLastRunAt: AutomationStore["Service"]["setLastRunAt"] = (automationId, at) =>
    sql`
      UPDATE project_automations SET last_run_at = ${at}, updated_at = ${at}
      WHERE automation_id = ${automationId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => persistenceError("AutomationStore.setLastRunAt", cause)),
    );

  const createRun: (input: CreateRunInput) => Effect.Effect<AutomationRun, AutomationError> =
    Effect.fn("AutomationStore.createRun")(function* (input) {
      const run: AutomationRun = {
        id: AutomationRunId.make(
          yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) => persistenceError("AutomationStore.createRun:id", cause)),
          ),
        ),
        automationId: input.automation.id,
        projectId: input.automation.projectId,
        trigger: input.trigger,
        status: input.status,
        threadId: input.threadId,
        scheduledFor: input.scheduledFor,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        error: input.error,
      };
      yield* sql`
      INSERT INTO automation_runs (
        run_id, automation_id, project_id, trigger, status, thread_id,
        scheduled_for, started_at, completed_at, error
      ) VALUES (
        ${run.id}, ${run.automationId}, ${run.projectId}, ${run.trigger}, ${run.status},
        ${run.threadId}, ${run.scheduledFor}, ${run.startedAt}, ${run.completedAt}, ${run.error}
      )
    `.pipe(Effect.mapError((cause) => persistenceError("AutomationStore.createRun", cause)));
      return run;
    });

  const admitRunInTransaction = Effect.fn("AutomationStore.admitRunInTransaction")(
    function* (input: {
      readonly automation: ProjectAutomation;
      readonly trigger: AutomationRunTrigger;
      readonly scheduledFor: string;
    }) {
      const active =
        input.automation.concurrencyPolicy === "skip"
          ? yield* hasActiveRun(input.automation.id)
          : false;
      if (!active) {
        return yield* createRun({
          ...input,
          status: "queued",
          threadId: null,
          startedAt: null,
          completedAt: null,
          error: null,
        });
      }

      const completedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* createRun({
        ...input,
        status: "skipped",
        threadId: null,
        startedAt: null,
        completedAt,
        error: "Skipped because another run is still active.",
      });
    },
  );

  const admitRun: AutomationStore["Service"]["admitRun"] = (input) =>
    sql
      .withTransaction(admitRunInTransaction(input))
      .pipe(
        Effect.mapError((cause) =>
          isAutomationError(cause) ? cause : persistenceError("AutomationStore.admitRun", cause),
        ),
      );

  const getRun = (runId: AutomationRunId): Effect.Effect<AutomationRun, AutomationError> =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ runId: AutomationRunId }),
      Result: AutomationRunDbRow,
      execute: ({ runId }) =>
        sql.unsafe(`SELECT ${runColumns} FROM automation_runs WHERE run_id = ?`, [runId]),
    })({ runId }).pipe(
      Effect.mapError((cause) => persistenceError("AutomationStore.getRun", cause)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new AutomationError({ reason: "not_found", message: "Automation run not found." }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        isAutomationError(cause) ? cause : persistenceError("AutomationStore.getRun", cause),
      ),
    );

  const updateRun: AutomationStore["Service"]["updateRun"] = Effect.fn("AutomationStore.updateRun")(
    function* (input) {
      const existing = yield* getRun(input.runId);
      const updated: AutomationRun = {
        ...existing,
        status: input.status,
        threadId: input.threadId === undefined ? existing.threadId : input.threadId,
        startedAt: input.startedAt === undefined ? existing.startedAt : input.startedAt,
        completedAt: input.completedAt === undefined ? existing.completedAt : input.completedAt,
        error: input.error === undefined ? existing.error : input.error,
      };
      yield* sql`
      UPDATE automation_runs SET
        status = ${updated.status},
        thread_id = ${updated.threadId},
        started_at = ${updated.startedAt},
        completed_at = ${updated.completedAt},
        error = ${updated.error}
      WHERE run_id = ${updated.id}
    `.pipe(Effect.mapError((cause) => persistenceError("AutomationStore.updateRun", cause)));
      return updated;
    },
  );

  const listRuns: AutomationStore["Service"]["listRuns"] = (automationId, limit) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: AutomationRunDbRow,
      execute: () =>
        sql.unsafe(
          `SELECT ${runColumns} FROM automation_runs WHERE automation_id = ? ORDER BY scheduled_for DESC, run_id DESC LIMIT ?`,
          [automationId, Math.max(1, Math.min(limit, 200))],
        ),
    })().pipe(Effect.mapError((cause) => persistenceError("AutomationStore.listRuns", cause)));

  const listActiveRuns: AutomationStore["Service"]["listActiveRuns"] = () =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: AutomationRunDbRow,
      execute: () =>
        sql.unsafe(
          `SELECT ${runColumns} FROM automation_runs WHERE status IN ('queued', 'running') ORDER BY scheduled_for ASC, run_id ASC`,
        ),
    })().pipe(
      Effect.mapError((cause) => persistenceError("AutomationStore.listActiveRuns", cause)),
    );

  const hasActiveRun: AutomationStore["Service"]["hasActiveRun"] = (automationId) =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ count: Schema.Number }),
      execute: () => sql`
        SELECT COUNT(*) AS count FROM automation_runs
        WHERE automation_id = ${automationId} AND status IN ('queued', 'running')
      `,
    })().pipe(
      Effect.map((row) => row.count > 0),
      Effect.mapError((cause) => persistenceError("AutomationStore.hasActiveRun", cause)),
    );

  return AutomationStore.of({
    list,
    get,
    create,
    update,
    delete: deleteAutomation,
    claimDue,
    admitRun,
    setLastRunAt,
    updateRun,
    listRuns,
    listActiveRuns,
    hasActiveRun,
  });
});

export const layer = Layer.effect(AutomationStore, make);
