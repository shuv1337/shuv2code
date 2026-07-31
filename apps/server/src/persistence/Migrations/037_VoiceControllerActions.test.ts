import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_VoiceControllerActions", (it) => {
  it.effect("enforces action correlation and operation-specific creation identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* sql`
        INSERT INTO voice_controller_bindings (
          environment_id,
          controller_thread_id,
          host_project_id,
          provider_instance_id,
          authorized_runtime_ceiling,
          binding_generation,
          control_epoch,
          state,
          created_at,
          updated_at
        )
        VALUES (
          'environment-1',
          'controller-1',
          'project-1',
          'codex',
          'approval-required',
          1,
          0,
          'active',
          '2026-07-30T00:00:00.000Z',
          '2026-07-30T00:00:00.000Z'
        )
      `;
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
        )
        VALUES (
          'transport-1',
          'environment-1',
          'controller-1',
          'transport-thread-1',
          'transport-runtime-1',
          1,
          'realtime-1',
          'active',
          '2026-07-30T00:00:00.000Z',
          '2026-07-30T00:00:00.000Z',
          NULL
        )
      `;

      const mismatchedClientIdentity = yield* Effect.exit(
        sql`
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
            created_at
          )
          VALUES (
            'action-invalid',
            'environment-1',
            'controller-1',
            'transport-1',
            'transport-runtime-1',
            1,
            'handoff-invalid',
            'item-invalid',
            'different-client-id',
            'controller-runtime-1',
            'queued',
            '2026-07-30T00:00:00.000Z'
          )
        `,
      );
      assert.isTrue(mismatchedClientIdentity._tag === "Failure");

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
          controller_provider_session_id,
          controller_provider_turn_id,
          state,
          created_at,
          controller_turn_bound_at
        )
        VALUES (
          'action-1',
          'environment-1',
          'controller-1',
          'transport-1',
          'transport-runtime-1',
          1,
          'handoff-1',
          'item-1',
          'action-1',
          'controller-runtime-1',
          'provider-session-1',
          'provider-turn-1',
          'active',
          '2026-07-30T00:00:00.000Z',
          '2026-07-30T00:00:01.000Z'
        )
      `;

      const bogusCreateIdentity = yield* Effect.exit(
        sql`
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
          )
          VALUES (
            'action-1',
            'mutation-1',
            'thread_send',
            'send:thread-1',
            'hash-1',
            'operation-1',
            'bogus-create-id',
            1,
            0,
            'never_dispatched',
            '2026-07-30T00:00:02.000Z',
            '2026-07-30T00:00:02.000Z'
          )
        `,
      );
      assert.isTrue(bogusCreateIdentity._tag === "Failure");

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
        )
        VALUES (
          'action-1',
          'mutation-1',
          'thread_create',
          'create:project-1',
          'hash-1',
          'operation-1',
          'provider-creation-1',
          1,
          0,
          'never_dispatched',
          '2026-07-30T00:00:02.000Z',
          '2026-07-30T00:00:02.000Z'
        )
      `;
    }),
  );
});
