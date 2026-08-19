import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A handoff negotiates the receiving listener while the current listener is
  // still active. Keep uniqueness for each role, then promote atomically.
  yield* sql`DROP INDEX idx_voice_transport_sessions_one_open_environment`;
  yield* sql`
    CREATE UNIQUE INDEX idx_voice_transport_sessions_one_active_environment
    ON voice_transport_sessions(environment_id)
    WHERE state IN ('active', 'closing')
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_voice_transport_sessions_one_negotiating_environment
    ON voice_transport_sessions(environment_id)
    WHERE state = 'negotiating'
  `;
});
