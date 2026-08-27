/**
 * Where a captain's deliberate model choice lives (issue #228).
 *
 * The model a bot runs on is resolved by a ladder, and the top rung is "the
 * captain said so". That rung needs a home of its own, because the obvious
 * place — the bot thread's `modelSelection` — cannot carry the fact: *every*
 * ADE thread is created with a machine-resolved selection, so reading it back
 * as a pin would freeze each bot on whatever the ladder happened to pick the
 * first time it ever chatted, and would freeze the bots created before the
 * ladder existed on the model that motivated this fix.
 *
 * So the column records provenance, not the effective model. `NULL` means "no
 * captain has chosen", which is what every existing row is and what the ladder
 * is for. The thread's `modelSelection` stays the *effective* model — it is
 * what the provider session is created with and what the picker shows — and is
 * refreshed whenever the ladder resolves something new.
 *
 * No instance id is stored: ADE bots run on the shuvcode kernel by definition
 * (spec §1) and `setBotModel` refuses a selection naming any other instance,
 * so a second column could only ever hold one value.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE ade_bots
    ADD COLUMN pinned_model_slug TEXT
  `;
});
