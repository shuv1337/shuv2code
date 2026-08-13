import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_VoiceSessionOwnership", (it) => {
  it.effect(
    "backfills owners, preserves the FK chain, and fences duplicate environment leases",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 48 });

        yield* sql`
        INSERT INTO voice_transport_sessions (
          transport_session_id,
          environment_id,
          controller_thread_id,
          transport_thread_id,
          runtime_instance_id,
          generation,
          state,
          created_at,
          updated_at
        ) VALUES
          (
            'older:1', 'environment-1', 'controller-old', 'transport-old', 'runtime-old', 1,
            'active', '2026-08-13T00:00:00.000Z', '2026-08-13T00:01:00.000Z'
          ),
          (
            'newer:1', 'environment-1', 'controller-new', 'transport-new', 'runtime-new', 1,
            'negotiating', '2026-08-13T00:02:00.000Z', '2026-08-13T00:03:00.000Z'
          )
      `;
        yield* sql`
        INSERT INTO voice_controller_actions (
          voice_action_id,
          environment_id,
          controller_thread_id,
          transport_session_id,
          transport_runtime_instance_id,
          transport_generation,
          handoff_id,
          handoff_item_id,
          client_user_message_id,
          controller_runtime_instance_id,
          state,
          created_at,
          closed_at
        ) VALUES (
          'action-old', 'environment-1', 'controller-old', 'older:1', 'runtime-old', 1,
          'handoff-old', 'item-old', 'action-old', 'controller-runtime', 'completed',
          '2026-08-13T00:00:10.000Z', '2026-08-13T00:00:20.000Z'
        )
      `;
        yield* sql`
        INSERT INTO voice_controller_mutations (
          voice_action_id,
          mutation_key,
          tool_name,
          semantic_slot,
          canonical_request_hash,
          operation_id,
          provider_creation_id,
          binding_generation,
          control_epoch,
          dispatch_state,
          created_at,
          updated_at
        ) VALUES (
          'action-old', 'mutation-old', 'thread_create', 'create:project-1', 'hash-old',
          'operation-old', 'provider-create-old', 1, 0, 'confirmed',
          '2026-08-13T00:00:11.000Z', '2026-08-13T00:00:20.000Z'
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 43 });

        const sessions = yield* sql<{
          readonly transportSessionId: string;
          readonly ownerKind: string;
          readonly ownerId: string;
          readonly state: string;
        }>`
        SELECT
          transport_session_id AS "transportSessionId",
          owner_kind AS "ownerKind",
          owner_id AS "ownerId",
          state
        FROM voice_transport_sessions
        ORDER BY transport_session_id
      `;
        assert.deepEqual(sessions, [
          {
            transportSessionId: "newer:1",
            ownerKind: "controller",
            ownerId: "controller-new",
            state: "negotiating",
          },
          {
            transportSessionId: "older:1",
            ownerKind: "controller",
            ownerId: "controller-old",
            state: "fenced",
          },
        ]);

        const preserved = yield* sql<{
          readonly voiceActionId: string;
          readonly mutationKey: string;
        }>`
        SELECT
          actions.voice_action_id AS "voiceActionId",
          mutations.mutation_key AS "mutationKey"
        FROM voice_controller_actions AS actions
        JOIN voice_controller_mutations AS mutations
          ON mutations.voice_action_id = actions.voice_action_id
      `;
        assert.deepEqual(preserved, [{ voiceActionId: "action-old", mutationKey: "mutation-old" }]);
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);

        const sameEnvironment = yield* Effect.exit(sql`
        INSERT INTO voice_transport_sessions (
          transport_session_id,
          environment_id,
          controller_thread_id,
          owner_kind,
          owner_id,
          transport_thread_id,
          runtime_instance_id,
          generation,
          state,
          created_at,
          updated_at
        ) VALUES (
          'conflict:1', 'environment-1', 'controller-third', 'thread', 'thread-third',
          'transport-third', 'runtime-third', 1, 'active',
          '2026-08-13T00:04:00.000Z', '2026-08-13T00:04:00.000Z'
        )
      `);
        assert.strictEqual(sameEnvironment._tag, "Failure");

        yield* sql`
        INSERT INTO voice_transport_sessions (
          transport_session_id,
          environment_id,
          controller_thread_id,
          owner_kind,
          owner_id,
          anchor_thread_id,
          transport_thread_id,
          runtime_instance_id,
          generation,
          state,
          created_at,
          updated_at
        ) VALUES (
          'other-environment:1', 'environment-2', 'controller-new', 'transcription',
          'request-1', 'controller-new', 'transport-other', 'runtime-other', 1, 'active',
          '2026-08-13T00:04:00.000Z', '2026-08-13T00:04:00.000Z'
        )
      `;
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }),
  );
});
