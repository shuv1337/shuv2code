import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0051 from "./051_ProjectionThreadMessageModality.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("051_ProjectionThreadMessageModality", (it) => {
  it.effect("defaults text rows and backfills existing voice projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_thread_messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          is_streaming INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages VALUES
          ('assistant:ordinary', 'thread-1', 'turn-1', 'assistant', 'Text', 0, 'now', 'now'),
          ('voice-speech:old', 'thread-1', 'turn-1', 'assistant', 'Spoken', 0, 'now', 'now'),
          ('voice-call:old:assistant', 'thread-1', 'turn-1', 'assistant', 'Realtime', 0, 'now', 'now')
      `;

      yield* Migration0051;

      const rows = yield* sql<{ readonly messageId: string; readonly modality: string }>`
        SELECT message_id AS "messageId", modality
        FROM projection_thread_messages
        ORDER BY message_id
      `;
      assert.deepEqual(rows, [
        { messageId: "assistant:ordinary", modality: "text" },
        { messageId: "voice-call:old:assistant", modality: "voice" },
        { messageId: "voice-speech:old", modality: "voice" },
      ]);
    }),
  );
});
