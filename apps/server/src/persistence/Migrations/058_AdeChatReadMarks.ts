/**
 * Roster liveness: the captain's per-conversation read mark
 * (`docs/ade/MESSENGER-PIVOT.md` §4, ticket M3 / #196).
 *
 * ADE is a single-captain product, so "who has read this" has exactly one
 * answer and a column on `ade_bots` beats a read-marks table: no row to create
 * before the first read, no orphan to sweep when a bot is deleted, and the
 * unread count falls out of the same row the roster already reads.
 *
 * NULL is "never opened", which is deliberately *not* the same as "read at the
 * epoch". A brand-new bot has an empty thread, so both answer zero unread; the
 * distinction only starts paying once a bot has spoken, and then NULL is the
 * honest statement that the captain has not seen any of it.
 *
 * The index is the S12 lesson written into the schema. The unread count is
 * "assistant messages in one thread that settled after a timestamp", and
 * without a covering index SQLite answers it by scanning every message in the
 * thread and testing `role` per row. The existing `(thread_id, created_at)` and
 * `(thread_id, created_at, message_id)` indexes cover the *latest-message* read
 * but not the role filter, so this is the one additive index the projection
 * needs to stay bounded as a thread grows.
 *
 * The trailing column is `updated_at`, not `created_at`, and that is the whole
 * point of the index rather than an incidental choice. An assistant row is
 * inserted when its first chunk arrives and keeps that `created_at` while the
 * turn streams; `updated_at` moves when it settles. A read mark placed while a
 * reply was mid-stream sits *after* that reply's `created_at`, so a
 * `created_at`-keyed unread predicate would hide the finished message forever.
 * Comparing on `updated_at` is what makes "unread" mean "settled after you last
 * looked", and the index has to agree with the predicate or the range scan
 * degrades back into a full-thread scan.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE ade_bots
    ADD COLUMN chat_last_read_at TEXT
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_role_updated
    ON projection_thread_messages(thread_id, role, updated_at)
  `;
});
