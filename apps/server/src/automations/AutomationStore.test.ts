import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AutomationListCursor,
  AutomationListResult,
  ProjectAutomation,
  ProjectId,
  ProviderInstanceId,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AutomationStore } from "./AutomationStore.ts";
import * as AutomationStoreLive from "./AutomationStore.ts";

const encodeLegacyAutomationList = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ automations: Schema.Array(ProjectAutomation) })),
);
const encodeAutomationList = Schema.encodeSync(Schema.fromJsonString(AutomationListResult));

const storeLayer = it.layer(
  AutomationStoreLive.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

storeLayer("AutomationStore", (it) => {
  it.effect("persists schedules, claims due work, and retains run history", () =>
    Effect.gen(function* () {
      const store = yield* AutomationStore;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("automation-project");

      yield* sql`DELETE FROM automation_runs`;
      yield* sql`DELETE FROM project_automations`;
      yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, 'Automation Project', '/tmp/automation-project', NULL,
          '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', NULL
        )
      `;

      const created = yield* store.create({
        projectId,
        name: "Morning report",
        prompt: "Produce the report",
        enabled: true,
        cronExpression: "0 9 * * *",
        timeZone: "Europe/London",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        concurrencyPolicy: "skip",
      });

      assert.strictEqual(created.projectId, projectId);
      assert.ok(created.nextRunAt !== null);
      assert.strictEqual((yield* store.list({ projectId })).automations.length, 1);

      const paused = yield* store.update({
        projectId,
        automationId: created.id,
        enabled: false,
      });
      assert.strictEqual(paused.enabled, false);
      assert.strictEqual(paused.nextRunAt, null);

      const enabled = yield* store.update({
        projectId,
        automationId: created.id,
        enabled: true,
      });
      yield* sql`
        UPDATE project_automations
        SET next_run_at = '2026-07-30T08:00:00.000Z'
        WHERE automation_id = ${enabled.id}
      `;
      const claimed = yield* store.claimDue("2026-07-30T08:00:01.000Z");
      assert.strictEqual(claimed.length, 1);
      assert.strictEqual(claimed[0]?.scheduledFor, "2026-07-30T08:00:00.000Z");

      const run = yield* store.updateRun({
        runId: claimed[0]!.run.id,
        status: "completed",
        startedAt: "2026-07-30T08:00:01.000Z",
        completedAt: "2026-07-30T08:05:00.000Z",
        error: null,
      });
      assert.strictEqual((yield* store.listRuns(created.id, 50))[0]?.id, run.id);

      yield* sql`
        UPDATE projection_projects
        SET deleted_at = '2026-07-30T08:06:00.000Z'
        WHERE project_id = ${projectId}
      `;
      yield* sql`
        UPDATE project_automations
        SET next_run_at = '2026-07-30T08:06:00.000Z'
        WHERE automation_id = ${created.id}
      `;
      assert.deepStrictEqual(yield* store.claimDue("2026-07-30T08:06:01.000Z"), []);

      assert.strictEqual(yield* store.delete(created.id), "deleted");
      assert.strictEqual((yield* store.listRuns(created.id, 50)).length, 0);
    }),
  );

  it.effect("claims each occurrence once and admits overlap atomically", () =>
    Effect.gen(function* () {
      const store = yield* AutomationStore;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("automation-concurrency-project");

      yield* sql`DELETE FROM automation_runs`;
      yield* sql`DELETE FROM project_automations`;
      yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, 'Automation concurrency project', '/tmp/automation-concurrency', NULL,
          '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', NULL
        )
      `;

      const automation = yield* store.create({
        projectId,
        name: "Concurrent report",
        prompt: "Produce the report",
        enabled: true,
        cronExpression: "0 9 * * *",
        timeZone: "Europe/London",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "anthropic/claude-sonnet-4-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        concurrencyPolicy: "skip",
      });
      const scheduledFor = "2026-07-30T08:00:00.000Z";
      yield* sql`
        UPDATE project_automations SET next_run_at = ${scheduledFor}
        WHERE automation_id = ${automation.id}
      `;

      const claims = yield* Effect.all(
        [store.claimDue("2026-07-30T08:00:01.000Z"), store.claimDue("2026-07-30T08:00:01.000Z")],
        { concurrency: "unbounded" },
      );
      const claimed = claims.flat();
      assert.strictEqual(claimed.length, 1);
      assert.strictEqual(claimed[0]?.run.status, "queued");
      assert.strictEqual((yield* store.listRuns(automation.id, 50)).length, 1);

      yield* store.updateRun({
        runId: claimed[0]!.run.id,
        status: "completed",
        completedAt: "2026-07-30T08:05:00.000Z",
      });
      const skipRuns = yield* Effect.all(
        [
          store.admitRun({
            automation,
            trigger: "manual",
            scheduledFor: "2026-07-30T09:00:00.000Z",
          }),
          store.admitRun({
            automation,
            trigger: "manual",
            scheduledFor: "2026-07-30T09:00:00.001Z",
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(skipRuns.map((run) => run.status).sort(), ["queued", "skipped"]);

      const parallel = yield* store.update({
        projectId,
        automationId: automation.id,
        concurrencyPolicy: "parallel",
      });
      const parallelRuns = yield* Effect.all(
        [
          store.admitRun({
            automation: parallel,
            trigger: "manual",
            scheduledFor: "2026-07-30T10:00:00.000Z",
          }),
          store.admitRun({
            automation: parallel,
            trigger: "manual",
            scheduledFor: "2026-07-30T10:00:00.001Z",
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(
        parallelRuns.map((run) => run.status),
        ["queued", "queued"],
      );
      assert.notStrictEqual(parallelRuns[0]?.id, parallelRuns[1]?.id);
    }),
  );

  it.effect("paginates bounded summaries without loading maximal prompts", () =>
    Effect.gen(function* () {
      const store = yield* AutomationStore;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("automation-pagination-project");
      const maximalPrompt = "x".repeat(120_000);

      yield* sql`DELETE FROM automation_runs`;
      yield* sql`DELETE FROM project_automations`;
      yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, 'Automation pagination project', '/tmp/automation-pagination', NULL,
          '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', NULL
        )
      `;

      const fullAutomations = yield* Effect.forEach(
        Array.from({ length: 25 }, (_, index) => index),
        (index) =>
          store.create({
            projectId,
            name: `Maximal prompt ${index.toString().padStart(2, "0")}`,
            prompt: maximalPrompt,
            enabled: index % 2 === 0,
            cronExpression: "0 9 * * *",
            timeZone: "UTC",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6-sol",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            concurrencyPolicy: "skip",
          }),
        { concurrency: 1 },
      );

      const first = yield* store.list({ projectId, limit: 10 });
      assert.strictEqual(first.automations.length, 10);
      assert.ok(first.nextCursor !== null);
      assert.ok(first.automations.every((automation) => automation.promptLength === 120_000));
      assert.ok(first.automations.every((automation) => automation.promptPreview.length === 120));
      assert.ok(first.automations.every((automation) => !("prompt" in automation)));

      const second = yield* store.list({
        projectId,
        limit: 10,
        cursor: first.nextCursor!,
      });
      const third = yield* store.list({
        projectId,
        limit: 10,
        cursor: second.nextCursor!,
      });
      assert.strictEqual(second.automations.length, 10);
      assert.strictEqual(third.automations.length, 5);
      assert.strictEqual(third.nextCursor, null);

      const summaries = [...first.automations, ...second.automations, ...third.automations];
      assert.deepStrictEqual(
        new Set(summaries.map((automation) => automation.id)),
        new Set(fullAutomations.map((automation) => automation.id)),
      );
      const legacyBytes = Buffer.byteLength(
        encodeLegacyAutomationList({ automations: fullAutomations }),
      );
      const paginatedSummaryBytes = Buffer.byteLength(
        encodeAutomationList({ automations: summaries, nextCursor: null }),
      );
      assert.ok(paginatedSummaryBytes < legacyBytes * 0.01);

      const enabled = yield* store.list({ projectId, enabled: true, limit: 100 });
      assert.strictEqual(enabled.automations.length, 13);
      assert.ok(enabled.automations.every((automation) => automation.enabled));

      const filteredFirst = yield* store.list({ projectId, enabled: true, limit: 5 });
      assert.ok(filteredFirst.nextCursor !== null);
      const filteredSecond = yield* store.list({
        projectId,
        cursor: filteredFirst.nextCursor!,
        limit: 5,
      });
      assert.strictEqual(filteredSecond.automations.length, 5);
      assert.ok(filteredSecond.automations.every((automation) => automation.enabled));

      const mismatchedFilterError = yield* store
        .list({
          projectId,
          enabled: false,
          cursor: filteredFirst.nextCursor!,
          limit: 5,
        })
        .pipe(Effect.flip);
      assert.strictEqual(mismatchedFilterError.reason, "invalid_cursor");

      const mismatchedProjectError = yield* store
        .list({
          projectId: ProjectId.make("another-automation-project"),
          cursor: filteredFirst.nextCursor!,
          limit: 5,
        })
        .pipe(Effect.flip);
      assert.strictEqual(mismatchedProjectError.reason, "invalid_cursor");

      const invalidCursorError = yield* store
        .list({ projectId, cursor: AutomationListCursor.make("not-a-cursor") })
        .pipe(Effect.flip);
      assert.strictEqual(invalidCursorError.reason, "invalid_cursor");
    }),
  );

  it.effect("caps pages and omits adversarial model metadata from summaries", () =>
    Effect.gen(function* () {
      const store = yield* AutomationStore;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("automation-bounded-summary-project");

      yield* sql`DELETE FROM automation_runs`;
      yield* sql`DELETE FROM project_automations`;
      yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, 'Bounded summary project', '/tmp/automation-bounded-summary', NULL,
          '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', NULL
        )
      `;

      const created = yield* Effect.forEach(
        Array.from({ length: 101 }, (_, index) => index),
        (index) =>
          store.create({
            projectId,
            name: `Bounded automation ${index.toString().padStart(3, "0")}`,
            prompt: "Run the bounded task",
            enabled: false,
            cronExpression: "0 9 * * *",
            timeZone: "UTC",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6-sol",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            concurrencyPolicy: "skip",
          }),
        { concurrency: 1 },
      );

      const adversarialModel = "m".repeat(200_000);
      const adversarialOption = "o".repeat(500_000);
      const adversarialModelSelection = JSON.stringify({
        instanceId: "codex",
        model: adversarialModel,
        options: [{ id: "payload", value: adversarialOption }],
      });
      yield* sql`
        UPDATE project_automations
        SET model_selection_json = ${adversarialModelSelection},
            created_at = '0000-01-01T00:00:00.000Z'
        WHERE automation_id = ${created[0]!.id}
      `;

      const page = yield* store.list({ projectId, limit: 100 });
      assert.strictEqual(page.automations.length, 100);
      assert.ok(page.nextCursor !== null);
      const adversarialSummary = page.automations.find(
        (automation) => automation.id === created[0]!.id,
      );
      assert.ok(adversarialSummary !== undefined);
      assert.strictEqual(adversarialSummary.modelInstanceId, "codex");
      assert.strictEqual(adversarialSummary.modelPreview, "m".repeat(120));
      assert.strictEqual(adversarialSummary.modelLength, 200_000);
      assert.ok(!("modelSelection" in adversarialSummary));
      assert.ok(Buffer.byteLength(encodeAutomationList(page)) < 256_000);

      const fullAutomation = Option.getOrThrow(yield* store.get(created[0]!.id));
      assert.strictEqual(fullAutomation.modelSelection.model.length, 200_000);
      assert.strictEqual(fullAutomation.modelSelection.options?.[0]?.value, adversarialOption);
    }),
  );
});
