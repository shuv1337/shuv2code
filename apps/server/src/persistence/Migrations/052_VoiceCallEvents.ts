import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE voice_call_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      transport_session_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      kind TEXT NOT NULL CHECK (kind IN (
        'listener.attached',
        'listener.detached',
        'speech.queued',
        'speech.started',
        'speech.completed',
        'speech.interrupted',
        'speech.failed'
      )),
      correlation_id TEXT,
      thread_snapshot_sequence INTEGER CHECK (
        thread_snapshot_sequence IS NULL OR thread_snapshot_sequence >= 0
      ),
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (transport_session_id)
        REFERENCES voice_transport_sessions(transport_session_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_voice_call_events_thread_cursor
    ON voice_call_events(environment_id, thread_id, event_id)
  `;
  yield* sql`
    CREATE INDEX idx_voice_call_events_transport
    ON voice_call_events(transport_session_id, event_id)
  `;
});
