/**
 * Who provisioned a bot, and the key that makes provisioning replay-safe
 * (spec `docs/ade/ADE-V1-SPEC.md` §3.2, issue #223).
 *
 * `create_bot` gives coordinators the captain's bot-from-template path. Two
 * columns are what make it behave like the rest of the tool plane:
 *
 * - **`created_by_bot_id`** is §3.2 structural attribution, persisted. The
 *   gate already resolves {bot, session} from the connection, so this is the
 *   durable record of that resolution — the same fact `ade_assignments`
 *   stores about who requested work. Null is a real value, not a backfill
 *   gap: it means the captain created the bot through `ade.createBotFromTemplate`
 *   (or the boot check did), which is exactly what every existing row is.
 * - **`provision_idempotency_key`** is the durable half of `create_bot`'s
 *   idempotency. The tool gate's re-request dedupe is in-memory only, and a
 *   voice mutation that reconciles as `indeterminate` is replayed by design —
 *   without this, a coordinator asking once for a coder after a restart ends
 *   up with "Coder" *and* "Coder 2". The unique index is the enforcement, the
 *   handler's short-circuit is the ergonomics.
 *
 * **No foreign key on `created_by_bot_id`.** `ade_bots.project_id` already
 * cascades a project delete onto its crew; adding a self-referential FK here
 * would make archiving or deleting a coordinator reach into rows that are
 * only *describing history*. An attribution to a bot that no longer exists
 * should read as an unresolvable name, not delete a working bot.
 *
 * **The unique index is partial on two conditions.** `WHERE … IS NOT NULL`
 * keeps every pre-existing row (and every captain-created one) out of the
 * constraint; `AND archived_at IS NULL` is what lets a coordinator legitimately
 * re-create a bot it archived — the key only claims the *live* bot, so replay
 * protection does not become a permanent ban on a name+template+project tuple.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE ade_bots
    ADD COLUMN created_by_bot_id TEXT
  `;

  yield* sql`
    ALTER TABLE ade_bots
    ADD COLUMN provision_idempotency_key TEXT
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_ade_bots_provision_idempotency
    ON ade_bots(provision_idempotency_key)
    WHERE provision_idempotency_key IS NOT NULL AND archived_at IS NULL
  `;
});
