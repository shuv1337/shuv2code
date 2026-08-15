import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE voice_calls (
      call_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'dormant', 'ended')),
      active_transport_session_id TEXT,
      active_device_id TEXT,
      active_device_label TEXT,
      active_device_kind TEXT CHECK (
        active_device_kind IS NULL OR active_device_kind IN ('desktop', 'mobile', 'web')
      ),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_voice_calls_one_active_environment
    ON voice_calls(environment_id)
    WHERE state = 'active'
  `;
  yield* sql`
    CREATE INDEX idx_voice_calls_environment_updated
    ON voice_calls(environment_id, updated_at DESC)
  `;

  yield* sql`ALTER TABLE voice_transport_sessions ADD COLUMN call_id TEXT`;
  yield* sql`ALTER TABLE voice_transport_sessions ADD COLUMN device_id TEXT`;
  yield* sql`ALTER TABLE voice_transport_sessions ADD COLUMN device_label TEXT`;
  yield* sql`ALTER TABLE voice_transport_sessions ADD COLUMN device_kind TEXT`;
  yield* sql`
    CREATE INDEX idx_voice_transport_sessions_call
    ON voice_transport_sessions(call_id, generation DESC)
  `;

  yield* sql`ALTER TABLE voice_call_events ADD COLUMN call_id TEXT`;
  yield* sql`ALTER TABLE voice_call_events ADD COLUMN device_id TEXT`;
  yield* sql`
    CREATE INDEX idx_voice_call_events_call_cursor
    ON voice_call_events(call_id, event_id)
  `;
});
