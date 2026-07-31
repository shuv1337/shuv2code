import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_VoiceControllerBindings", (it) => {
  it.effect("backfills purpose and enforces the purpose and runtime ceiling lattices", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          snoozed_until,
          snoozed_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'historical-thread',
          'project-1',
          'Historical',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'approval-required',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-07-30T00:00:00.000Z',
          '2026-07-30T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const historical = yield* sql<{ readonly purpose: string }>`
        SELECT purpose
        FROM projection_threads
        WHERE thread_id = 'historical-thread'
      `;
      assert.strictEqual(historical[0]?.purpose, "standard");

      for (const purpose of ["standard", "voice-controller", "voice-transport"] as const) {
        yield* sql`
          UPDATE projection_threads
          SET purpose = ${purpose}
          WHERE thread_id = 'historical-thread'
        `;
      }
      const invalidPurpose = yield* Effect.exit(
        sql`
          UPDATE projection_threads
          SET purpose = 'ordinary-controller'
          WHERE thread_id = 'historical-thread'
        `,
      );
      assert.isTrue(invalidPurpose._tag === "Failure");

      for (const [index, ceiling] of [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ].entries()) {
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
            ${`environment-${index}`},
            ${`controller-${index}`},
            'project-1',
            'codex',
            ${ceiling},
            1,
            0,
            'provisioning',
            '2026-07-30T00:00:00.000Z',
            '2026-07-30T00:00:00.000Z'
          )
        `;
      }

      const invalidCeiling = yield* Effect.exit(
        sql`
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
            'environment-invalid',
            'controller-invalid',
            'project-1',
            'codex',
            'read-only',
            1,
            0,
            'provisioning',
            '2026-07-30T00:00:00.000Z',
            '2026-07-30T00:00:00.000Z'
          )
        `,
      );
      assert.isTrue(invalidCeiling._tag === "Failure");
    }),
  );
});
