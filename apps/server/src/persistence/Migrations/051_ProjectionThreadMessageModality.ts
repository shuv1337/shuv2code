import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN modality TEXT NOT NULL DEFAULT 'text'
    CHECK (modality IN ('text', 'voice'))
  `;

  // Voice messages projected before modality was first-class used stable,
  // namespaced ids. Backfill those existing rows once so a reload makes
  // already-recorded calls visible without teaching the UI about storage ids.
  yield* sql`
    UPDATE projection_thread_messages
    SET modality = 'voice'
    WHERE message_id LIKE 'voice-speech:%'
       OR message_id LIKE 'voice-call:%'
  `;
});
