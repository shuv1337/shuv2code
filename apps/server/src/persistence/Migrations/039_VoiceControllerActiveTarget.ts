import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(voice_controller_bindings)
  `;
  if (!columns.some((column) => column.name === "active_target_thread_id")) {
    yield* sql`
      ALTER TABLE voice_controller_bindings
      ADD COLUMN active_target_thread_id TEXT
    `;
  }
});
