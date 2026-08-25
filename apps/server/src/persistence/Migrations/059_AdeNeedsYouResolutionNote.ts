/**
 * Whether a resolved Needs You item was *answered* or merely *dismissed*
 * (`docs/ade/MESSENGER-PIVOT.md` §6 M5 / #196).
 *
 * M5 makes `form` an answerable kind: the captain types a value, the item
 * retires. But `submitNeedsYouDecision` withholds a `form` note by design — a
 * form answer is assumed to be a credential, and `note` is the field that
 * reaches `ade_integration_candidates.verdict_detail` and, on a denial, a
 * bot-facing repair instruction. Withholding it left the two outcomes
 * indistinguishable afterwards: `status = 'resolved'` alone cannot say whether
 * the captain supplied what was asked for or waved the card away.
 *
 * So the fact is recorded and the value is not. This column is a flag, never a
 * length and never a prefix: a length is a real signal about a secret, and the
 * audit question ("did an answer arrive?") does not need one. `NOT NULL DEFAULT
 * 0` because every row that already exists was resolved without one.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE ade_needs_you_items
    ADD COLUMN resolution_note_present INTEGER NOT NULL DEFAULT 0
  `;
});
