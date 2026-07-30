import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AutomationStore } from "./AutomationStore.ts";
import * as AutomationStoreLive from "./AutomationStore.ts";

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
      assert.strictEqual((yield* store.list(projectId)).length, 1);

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
});
