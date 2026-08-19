import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_VoiceTransportLeaseIdentity", (it) => {
  it.effect("allows a new client to reuse generation one after the old lease closed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* sql`
        INSERT INTO voice_transport_sessions (
          transport_session_id,
          environment_id,
          controller_thread_id,
          transport_thread_id,
          runtime_instance_id,
          generation,
          realtime_session_id,
          state,
          created_at,
          updated_at,
          closed_at
        ) VALUES (
          'old-client:1',
          'environment-1',
          'controller-1',
          'old-transport-thread',
          'old-runtime',
          1,
          'old-realtime',
          'closed',
          '2026-08-09T00:00:00.000Z',
          '2026-08-09T00:01:00.000Z',
          '2026-08-09T00:01:00.000Z'
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
          'old-action',
          'environment-1',
          'controller-1',
          'old-client:1',
          'old-runtime',
          1,
          'old-handoff',
          'old-item',
          'old-action',
          'controller-runtime',
          'completed',
          '2026-08-09T00:00:10.000Z',
          '2026-08-09T00:00:20.000Z'
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
          'old-action',
          'old-mutation',
          'thread_create',
          'create:project-1',
          'old-hash',
          'old-operation',
          'old-provider-creation',
          1,
          0,
          'confirmed',
          '2026-08-09T00:00:11.000Z',
          '2026-08-09T00:00:20.000Z'
        )
      `;

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
        ) VALUES (
          'new-client:1',
          'environment-1',
          'controller-1',
          'new-transport-thread',
          'new-runtime',
          1,
          'active',
          '2026-08-09T01:00:00.000Z',
          '2026-08-09T01:00:00.000Z'
        )
      `;

      const transports = yield* sql<{
        readonly transportSessionId: string;
        readonly generation: number;
      }>`
        SELECT
          transport_session_id AS "transportSessionId",
          generation
        FROM voice_transport_sessions
        WHERE controller_thread_id = 'controller-1'
        ORDER BY created_at
      `;
      assert.deepEqual(transports, [
        { transportSessionId: "old-client:1", generation: 1 },
        { transportSessionId: "new-client:1", generation: 1 },
      ]);

      const preservedActions = yield* sql<{ readonly voiceActionId: string }>`
        SELECT voice_action_id AS "voiceActionId"
        FROM voice_controller_actions
      `;
      assert.deepEqual(preservedActions, [{ voiceActionId: "old-action" }]);

      const preservedMutations = yield* sql<{
        readonly voiceActionId: string;
        readonly toolName: string;
        readonly providerCreationId: string | null;
      }>`
        SELECT
          voice_action_id AS "voiceActionId",
          tool_name AS "toolName",
          provider_creation_id AS "providerCreationId"
        FROM voice_controller_mutations
      `;
      assert.deepEqual(preservedMutations, [
        {
          voiceActionId: "old-action",
          toolName: "thread_create",
          providerCreationId: "old-provider-creation",
        },
      ]);

      const foreignKeyViolations = yield* sql`PRAGMA foreign_key_check`;
      assert.deepEqual(foreignKeyViolations, []);

      const secondOpen = yield* Effect.exit(sql`
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
        ) VALUES (
          'third-client:1',
          'environment-1',
          'controller-1',
          'third-transport-thread',
          'third-runtime',
          1,
          'negotiating',
          '2026-08-09T02:00:00.000Z',
          '2026-08-09T02:00:00.000Z'
        )
      `);
      assert.strictEqual(secondOpen._tag, "Failure");
    }),
  );
});
