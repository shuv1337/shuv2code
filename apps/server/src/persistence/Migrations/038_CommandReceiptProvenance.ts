import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_command_receipts)
  `;

  if (!columns.some((column) => column.name === "command_type")) {
    yield* sql`
      ALTER TABLE orchestration_command_receipts
      ADD COLUMN command_type TEXT
    `;
  }

  if (!columns.some((column) => column.name === "canonical_command_hash")) {
    yield* sql`
      ALTER TABLE orchestration_command_receipts
      ADD COLUMN canonical_command_hash TEXT
    `;
  }

  if (!columns.some((column) => column.name === "actor_provenance_json")) {
    yield* sql`
      ALTER TABLE orchestration_command_receipts
      ADD COLUMN actor_provenance_json TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_command_receipts_canonical_hash
    ON orchestration_command_receipts(command_type, canonical_command_hash)
  `;
});
