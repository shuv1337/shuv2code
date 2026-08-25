/**
 * Routines: which ADE bot an automation belongs to
 * (`docs/ade/MESSENGER-PIVOT.md` §4, ticket M6 / #196).
 *
 * The captain's right rail lists a bot's routines, and routines are not a new
 * mechanism — they are `project_automations` rows run by the existing
 * scheduler. So the whole backend delta is one nullable column: no ADE-side
 * cron, no second table, no second history.
 *
 * Three decisions worth naming, because each is a place a later change could
 * quietly break the feature:
 *
 * - **Nullable, and null means the project's.** Every automation that exists
 *   today, and every one created from Settings tomorrow, has no bot. That is a
 *   real state, not a backfill gap: the rail shows a bot its own routines *and*
 *   its project's, so an unattributed row is visible rather than orphaned.
 * - **No foreign key to `ade_bots`.** A routine's schedule is a promise to the
 *   captain, not to the bot named on it. `ON DELETE CASCADE` would silently
 *   delete a working nightly job because its bot was archived, and
 *   `ON DELETE SET NULL` would need the FK's write lock on a table in a
 *   different subsystem for no benefit the read path can see — an
 *   attribution to a bot that no longer exists simply stops matching the
 *   rail's filter and falls back to being project-wide.
 * - **The index is `(ade_bot_id, project_id)`**, not the reverse. The rail's
 *   query is always "this bot, in this project"; `idx_project_automations_project`
 *   already serves the project-first order the Settings list pages through.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE project_automations
    ADD COLUMN ade_bot_id TEXT
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_automations_bot
    ON project_automations(ade_bot_id, project_id)
  `;
});
