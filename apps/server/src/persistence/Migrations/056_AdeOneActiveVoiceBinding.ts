/**
 * One active voice binding per bot (spec `docs/ade/ADE-V1-SPEC.md` §4.7, S16).
 *
 * 055 made "one active primary-text session per bot" a schema fact rather than
 * a rule someone remembers, and §4.7's per-bot voice binding needs exactly the
 * same protection for exactly the same reason: opening a voice call is
 * retire-then-open across two statements, so two concurrent redials can
 * interleave into two live voice bindings, each handing a realtime session the
 * same bot's authority.
 *
 * Additive and idempotent-safe: existing rows are untouched, and a fleet that
 * somehow already carries a duplicate would fail this migration loudly rather
 * than silently keeping the ambiguity — which is the correct outcome, because
 * nothing downstream can tell which of the two is the real call.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE UNIQUE INDEX idx_ade_bot_execution_bindings_one_active_voice
    ON ade_bot_execution_bindings(bot_id)
    WHERE purpose = 'voice' AND status = 'active'
  `;
});
