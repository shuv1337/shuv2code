import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const seedBot = (botId: string, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    INSERT INTO ade_bots (bot_id, name, structural_role, role_tag, created_at)
    VALUES (${botId}, ${name}, 'crew', 'Coder', '2026-08-24T00:00:00.000Z')
  `;
  });

layer("057_AdeBotGroups", (it) => {
  /**
   * The schema-level statement of "a group is organization, not ownership":
   * dropping the bucket must leave every bot standing. Asserted here as well
   * as in the service test because the service could be rewritten and this
   * clause is what would still catch it.
   */
  it.effect("ungroups members on delete instead of cascading into the bots", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`PRAGMA foreign_keys = ON`;

      yield* sql`
        INSERT INTO ade_bot_groups (group_id, name, order_index, created_at)
        VALUES ('group-1', 'Backend', 0, '2026-08-24T00:00:00.000Z')
      `;
      yield* seedBot("bot-1", "Code Monkey");
      yield* seedBot("bot-2", "Reviewer");
      yield* sql`UPDATE ade_bots SET group_id = 'group-1' WHERE bot_id IN ('bot-1', 'bot-2')`;

      yield* sql`DELETE FROM ade_bot_groups WHERE group_id = 'group-1'`;

      const rows = yield* sql<{ bot_id: string; group_id: string | null }>`
        SELECT bot_id, group_id FROM ade_bots ORDER BY bot_id
      `;
      assert.deepEqual(rows, [
        { bot_id: "bot-1", group_id: null },
        { bot_id: "bot-2", group_id: null },
      ]);
    }),
  );

  it.effect("refuses two groups with the same rail header", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`
        INSERT INTO ade_bot_groups (group_id, name, order_index, created_at)
        VALUES ('group-1', 'Backend', 0, '2026-08-24T00:00:00.000Z')
      `;
      const duplicate = yield* Effect.result(sql`
        INSERT INTO ade_bot_groups (group_id, name, order_index, created_at)
        VALUES ('group-2', 'Backend', 1, '2026-08-24T00:00:00.000Z')
      `);

      assert.equal(duplicate._tag, "Failure");
    }),
  );

  it.effect("starts every existing bot Ungrouped", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedBot("bot-fresh", "Fresh Crew");

      const rows = yield* sql<{ group_id: string | null }>`
        SELECT group_id FROM ade_bots WHERE bot_id = 'bot-fresh'
      `;
      assert.equal(rows[0]?.group_id, null);
    }),
  );
});
