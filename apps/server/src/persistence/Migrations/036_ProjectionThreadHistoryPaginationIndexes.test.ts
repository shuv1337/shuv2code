import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ProjectionThreadHistoryPaginationIndexes", (it) => {
  it.effect("creates the proposed-plan keyset pagination index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* runMigrations({ toMigrationInclusive: 36 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_thread_proposed_plans_thread_created_id')
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["thread_id", "created_at", "plan_id"],
      );
    }),
  );
});
