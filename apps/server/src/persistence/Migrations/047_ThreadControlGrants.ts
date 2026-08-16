import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE thread_control_grants (
      thread_id TEXT PRIMARY KEY NOT NULL,
      authorized_runtime_ceiling TEXT NOT NULL,
      control_enabled INTEGER NOT NULL CHECK (control_enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
