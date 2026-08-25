import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("058_AdeChatReadMarks", (it) => {
  it.effect("starts every existing bot as never-read rather than read-at-the-epoch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO ade_bots (bot_id, name, structural_role, role_tag, created_at)
        VALUES ('bot-1', 'Code Monkey', 'crew', 'Coder', '2026-08-24T00:00:00.000Z')
      `;

      const rows = yield* sql<{ chat_last_read_at: string | null }>`
        SELECT chat_last_read_at FROM ade_bots WHERE bot_id = 'bot-1'
      `;
      assert.equal(rows[0]?.chat_last_read_at, null);
    }),
  );

  /**
   * The S12 lesson as a schema assertion. Without this index the unread count
   * is a per-row `role` test over the whole thread, which degrades silently and
   * only on the busiest conversation — exactly the shape that is invisible in a
   * test fixture and expensive in a real fleet.
   */
  it.effect("indexes the unread count so it stays a range scan as a thread grows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const plan = yield* sql<{ detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT COUNT(*) FROM projection_thread_messages
        WHERE thread_id = 'ade-bot-bot-1' AND role = 'assistant' AND created_at > '2026-01-01'
      `;

      const detail = plan.map((row) => row.detail).join(" ");
      assert.include(detail, "idx_projection_thread_messages_thread_role_created");
      assert.notInclude(detail, "SCAN projection_thread_messages");
    }),
  );
});
