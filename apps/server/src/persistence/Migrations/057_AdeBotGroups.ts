/**
 * Captain-defined contact groups for the messenger rail
 * (`docs/ade/MESSENGER-PIVOT.md` §4, ticket M2 / #197).
 *
 * A group is pure captain-authored organization: it names a bucket in the
 * contact rail and nothing else. That is why the membership edge lives on
 * `ade_bots` as a nullable column rather than in a join table — a bot is in at
 * most one group, "Ungrouped" is the absence of a group rather than a row, and
 * the single-captain product has no second organizer to reconcile with.
 *
 * `ON DELETE SET NULL` is the load-bearing clause: deleting a group must
 * *ungroup* its members, never cascade into deleting bots. Bot deletion is a
 * confirm-gated destructive operation that also destroys a desktop (spec
 * §4.6); an organizational tidy-up must not be able to reach it, and making
 * that a schema fact means no future call site can get it wrong.
 *
 * The uniqueness index on `name` keeps the rail unambiguous: two groups called
 * "Backend" would render as two identical headers with no way to tell them
 * apart, so upsert-by-name is the honest behavior and the index is what forces
 * the service to implement it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE ade_bot_groups (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 80),
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;

  // `NOCASE`, because "Backend" and "backend" are the same header to the
  // person reading the rail. Case-sensitive uniqueness would let two groups
  // sit under headers nobody can tell apart, which is the exact ambiguity this
  // index exists to prevent.
  yield* sql`
    CREATE UNIQUE INDEX idx_ade_bot_groups_name
    ON ade_bot_groups(name COLLATE NOCASE)
  `;

  // Rail order: captain-chosen index first, creation order as the stable tie
  // break so two groups added in the same tick cannot swap places on reload.
  yield* sql`
    CREATE INDEX idx_ade_bot_groups_order
    ON ade_bot_groups(order_index, created_at)
  `;

  // SQLite permits a REFERENCES clause on ADD COLUMN as long as the implied
  // default is NULL — which is exactly the semantics wanted: every existing
  // bot starts Ungrouped.
  yield* sql`
    ALTER TABLE ade_bots
    ADD COLUMN group_id TEXT REFERENCES ade_bot_groups(group_id) ON DELETE SET NULL
  `;

  yield* sql`
    CREATE INDEX idx_ade_bots_group
    ON ade_bots(group_id, name)
  `;
});
