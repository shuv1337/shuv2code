import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0053 from "./053_VoiceCallOwnership.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_VoiceCallOwnership", (it) => {
  it.effect("adds stable Call ownership above ephemeral transport sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE voice_transport_sessions (
          transport_session_id TEXT PRIMARY KEY
        )
      `;
      yield* sql`
        CREATE UNIQUE INDEX idx_voice_transport_sessions_one_open_environment
        ON voice_transport_sessions(transport_session_id)
      `;
      yield* sql`
        CREATE TABLE voice_call_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT
        )
      `;

      yield* Migration0053;
      yield* sql`
        INSERT INTO voice_calls (
          call_id,
          environment_id,
          thread_id,
          state,
          active_transport_session_id,
          active_device_id,
          active_device_label,
          active_device_kind,
          revision,
          created_at,
          updated_at,
          ended_at
        ) VALUES (
          'call-1',
          'environment-1',
          'thread-1',
          'active',
          'transport-1',
          'desktop-1',
          'Desktop',
          'desktop',
          1,
          '2026-08-15T23:00:00.000Z',
          '2026-08-15T23:00:00.000Z',
          NULL
        )
      `;

      const calls = yield* sql<{ readonly callId: string; readonly revision: number }>`
        SELECT call_id AS "callId", revision FROM voice_calls
      `;
      const transportColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(voice_transport_sessions)
      `;
      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(voice_call_events)
      `;

      assert.deepEqual(calls, [{ callId: "call-1", revision: 1 }]);
      assert.isTrue(transportColumns.some((column) => column.name === "call_id"));
      assert.isTrue(transportColumns.some((column) => column.name === "device_id"));
      assert.isTrue(eventColumns.some((column) => column.name === "call_id"));
      assert.isTrue(eventColumns.some((column) => column.name === "device_id"));
    }),
  );
});
