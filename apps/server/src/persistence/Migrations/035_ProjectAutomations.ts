import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE project_automations (
      automation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      cron_expression TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      concurrency_policy TEXT NOT NULL DEFAULT 'skip' CHECK (concurrency_policy IN ('skip', 'parallel')),
      next_run_at TEXT,
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX idx_project_automations_project
    ON project_automations(project_id, created_at, automation_id)
  `;

  yield* sql`
    CREATE INDEX idx_project_automations_due
    ON project_automations(enabled, next_run_at)
  `;

  yield* sql`
    CREATE TABLE automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
      thread_id TEXT,
      scheduled_for TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      FOREIGN KEY (automation_id) REFERENCES project_automations(automation_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX idx_automation_runs_automation
    ON automation_runs(automation_id, scheduled_for DESC, run_id DESC)
  `;

  yield* sql`
    CREATE INDEX idx_automation_runs_active
    ON automation_runs(automation_id, status)
    WHERE status IN ('queued', 'running')
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_automation_runs_scheduled_once
    ON automation_runs(automation_id, scheduled_for)
    WHERE trigger = 'scheduled'
  `;
});
