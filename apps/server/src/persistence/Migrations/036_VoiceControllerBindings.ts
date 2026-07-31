import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionThreadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!projectionThreadColumns.some((column) => column.name === "purpose")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN purpose TEXT NOT NULL DEFAULT 'standard'
      CHECK (purpose IN ('standard', 'voice-controller', 'voice-transport'))
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET purpose = 'standard'
    WHERE purpose IS NULL
       OR purpose NOT IN ('standard', 'voice-controller', 'voice-transport')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_purpose
    ON projection_threads(purpose, deleted_at, archived_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS voice_controller_bindings (
      environment_id TEXT PRIMARY KEY,
      controller_thread_id TEXT NOT NULL UNIQUE,
      host_project_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      authorized_runtime_ceiling TEXT NOT NULL
        CHECK (
          authorized_runtime_ceiling IN (
            'approval-required',
            'auto-accept-edits',
            'auto',
            'full-access'
          )
        ),
      binding_generation INTEGER NOT NULL DEFAULT 1 CHECK (binding_generation >= 1),
      control_epoch INTEGER NOT NULL DEFAULT 0 CHECK (control_epoch >= 0),
      state TEXT NOT NULL
        CHECK (state IN ('provisioning', 'active', 'dormant', 'resetting')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_voice_controller_bindings_host_project
    ON voice_controller_bindings(host_project_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS voice_controller_binding_generations (
      environment_id TEXT PRIMARY KEY,
      last_generation INTEGER NOT NULL CHECK (last_generation >= 1),
      updated_at TEXT NOT NULL
    )
  `;
});
