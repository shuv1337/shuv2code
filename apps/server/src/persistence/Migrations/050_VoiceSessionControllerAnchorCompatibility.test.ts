import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0050 from "./050_VoiceSessionControllerAnchorCompatibility.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_VoiceSessionControllerAnchorCompatibility", (it) => {
  it.effect("upgrades the previously shipped owner-only transport table in place", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE voice_transport_sessions (
          transport_session_id TEXT PRIMARY KEY,
          environment_id TEXT NOT NULL,
          owner_kind TEXT NOT NULL
            CHECK (owner_kind IN ('controller', 'thread-call', 'transcription-test')),
          owner_id TEXT NOT NULL,
          provider_anchor_thread_id TEXT,
          transport_thread_id TEXT NOT NULL,
          runtime_instance_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          realtime_session_id TEXT,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT
        )
      `;
      yield* sql`
        INSERT INTO voice_transport_sessions VALUES
          ('controller:1', 'environment', 'controller', 'controller-thread', NULL,
            'transport-1', 'runtime-1', 1, NULL, 'closed', 'now', 'now', 'now'),
          ('call:1', 'environment', 'thread-call', 'called-thread', NULL,
            'transport-2', 'runtime-2', 1, NULL, 'closed', 'now', 'now', 'now'),
          ('transcription:1', 'environment', 'transcription-test', 'request-1', 'anchor-thread',
            'transport-3', 'runtime-3', 1, NULL, 'closed', 'now', 'now', 'now')
      `;

      yield* Migration0050;

      const rows = yield* sql<{
        readonly transportSessionId: string;
        readonly controllerThreadId: string;
      }>`
        SELECT
          transport_session_id AS "transportSessionId",
          controller_thread_id AS "controllerThreadId"
        FROM voice_transport_sessions
        ORDER BY transport_session_id
      `;
      assert.deepEqual(rows, [
        { transportSessionId: "call:1", controllerThreadId: "called-thread" },
        { transportSessionId: "controller:1", controllerThreadId: "controller-thread" },
        { transportSessionId: "transcription:1", controllerThreadId: "anchor-thread" },
      ]);
    }),
  );
});
