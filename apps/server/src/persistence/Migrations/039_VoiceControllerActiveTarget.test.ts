import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_VoiceControllerActiveTarget", (it) => {
  it.effect("adds a nullable durable active target without changing existing bindings", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });
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

      yield* runMigrations({ toMigrationInclusive: 39 });

      const rows = yield* sql<{ readonly activeTargetThreadId: string | null }>`
        SELECT active_target_thread_id AS "activeTargetThreadId"
        FROM voice_controller_bindings
        WHERE environment_id = 'environment-1'
      `;
      assert.deepStrictEqual(rows, [{ activeTargetThreadId: null }]);
    }),
  );
});
