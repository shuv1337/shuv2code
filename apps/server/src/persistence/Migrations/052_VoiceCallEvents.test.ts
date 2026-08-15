import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0052 from "./052_VoiceCallEvents.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_VoiceCallEvents", (it) => {
  it.effect("persists ordered Call lifecycle evidence across transport generations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE voice_transport_sessions (
          transport_session_id TEXT PRIMARY KEY
        )
      `;
      yield* sql`
        INSERT INTO voice_transport_sessions VALUES ('transport-1'), ('transport-2')
      `;

      yield* Migration0052;
      yield* sql`
        INSERT INTO voice_call_events (
          environment_id,
          thread_id,
          transport_session_id,
          generation,
          kind,
          correlation_id,
          thread_snapshot_sequence,
          payload_json,
          occurred_at
        ) VALUES
          ('environment-1', 'thread-1', 'transport-1', 1, 'listener.detached', NULL, 41, '{}', '2026-08-15T20:00:00.000Z'),
          ('environment-1', 'thread-1', 'transport-2', 2, 'listener.attached', NULL, 49, '{}', '2026-08-15T20:05:00.000Z')
      `;

      const rows = yield* sql<{
        readonly eventId: number;
        readonly kind: string;
        readonly sequence: number | null;
      }>`
        SELECT
          event_id AS "eventId",
          kind,
          thread_snapshot_sequence AS sequence
        FROM voice_call_events
        ORDER BY event_id
      `;
      assert.deepEqual(rows, [
        { eventId: 1, kind: "listener.detached", sequence: 41 },
        { eventId: 2, kind: "listener.attached", sequence: 49 },
      ]);
    }),
  );
});
