import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Development builds briefly shipped migration 043 without the Controller
 * compatibility anchor. Upgrade those databases in place; fresh databases
 * already receive the stricter NOT NULL column from migration 043.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(voice_transport_sessions)
  `;
  if (!columns.some((column) => column.name === "controller_thread_id")) {
    yield* sql`
      ALTER TABLE voice_transport_sessions
      ADD COLUMN controller_thread_id TEXT
    `;
    yield* sql`
      UPDATE voice_transport_sessions
      SET controller_thread_id = CASE owner_kind
        WHEN 'controller' THEN owner_id
        WHEN 'thread-call' THEN owner_id
        WHEN 'transcription-test' THEN provider_anchor_thread_id
      END
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_voice_transport_sessions_controller_compat
    ON voice_transport_sessions(controller_thread_id, generation DESC)
  `;
});
