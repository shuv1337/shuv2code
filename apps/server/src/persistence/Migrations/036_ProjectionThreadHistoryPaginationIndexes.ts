import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_created_id
    ON projection_thread_proposed_plans(thread_id, created_at, plan_id)
  `;
});
