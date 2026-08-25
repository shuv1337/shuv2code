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
   * The S12 lesson as a plan assertion, on **both** hot queries and on the
   * exact SQL `readRosterLiveness` runs rather than a paraphrase of it. The
   * first version of this test guarded a third shape that nothing executed,
   * which is how two genuinely unbounded queries shipped under a green test:
   * an `EXPLAIN QUERY PLAN` assertion is only worth the fidelity of the string
   * it plans.
   *
   * These run at 250ms per subscribed rail, so a plan regression here is not a
   * slow page — it is a background scan of every message in the database, four
   * times a second.
   */
  it.effect("plans the tail read as a two-row backwards index walk", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const plan = yield* sql<{ detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id, message_id, role, text, created_at
        FROM projection_thread_messages
        WHERE thread_id = 'ade-bot-bot-1' AND is_streaming = 0
        ORDER BY created_at DESC, message_id DESC
        LIMIT 2
      `;
      const detail = plan.map((row) => row.detail).join(" ");

      assert.include(detail, "USING INDEX idx_projection_thread_messages_thread_created");
      // A full scan means the per-thread bound stopped applying.
      assert.notInclude(detail, "SCAN projection_thread_messages");
      // The ranking must come from the index walk, not from a sort. A temp
      // b-tree here is the `ROW_NUMBER()` cost this query exists to avoid.
      assert.notInclude(detail, "USE TEMP B-TREE");
    }),
  );

  it.effect("plans the unread count as a single sargable range, not a scan", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      // Verbatim the roster's unread read. The `COALESCE` is load-bearing: the
      // `OR chat_last_read_at IS NULL` form it replaced is a disjunction over a
      // column the index cannot seek on, and the planner answered it by
      // scanning every message in the thread.
      const plan = yield* sql<{ detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT bot.bot_id AS bot_id, COUNT(message.message_id) AS unread
        FROM ade_bots AS bot
        LEFT JOIN projection_thread_messages AS message
          ON message.thread_id = 'ade-bot-' || bot.bot_id
         AND message.role = 'assistant'
         AND message.is_streaming = 0
         AND message.updated_at > COALESCE(bot.chat_last_read_at, '')
        WHERE bot.archived_at IS NULL
        GROUP BY bot.bot_id
      `;
      const detail = plan.map((row) => row.detail).join(" ");

      assert.include(detail, "idx_projection_thread_messages_thread_role_updated");
      assert.notInclude(detail, "SCAN message");
      // The load-bearing assertion, and the one "uses the index" alone would
      // have missed: the *timestamp* has to be part of the seek. The rejected
      // `OR … IS NULL` form still reported this index, but only as
      // `(thread_id=? AND role=?)` — every assistant message in the thread
      // visited and filtered per row. The third term is the whole fix.
      assert.include(detail, "updated_at>?");
    }),
  );

  /**
   * The index has to agree with the predicate's column or the range collapses.
   * Asserted separately because "the index exists" and "the index is the one
   * the query can use" are different facts, and D6 moved the predicate from
   * `created_at` to `updated_at` after the index already shipped.
   */
  it.effect("indexes settle time, which is what unread compares", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const columns = yield* sql<{ name: string }>`
        PRAGMA index_info('idx_projection_thread_messages_thread_role_updated')
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        ["thread_id", "role", "updated_at"],
      );
    }),
  );
});
