import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("059_AdeNeedsYouResolutionNote", (it) => {
  it.effect("defaults an item to answerless, so an old row reads honestly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO ade_needs_you_items (
          needs_you_item_id, kind, subject_refs_json, status, created_at, updated_at, resolved_at
        ) VALUES (
          'ny-1', 'form', '[]', 'open',
          '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', NULL
        )
      `;

      const rows = yield* sql<{ resolution_note_present: number }>`
        SELECT resolution_note_present FROM ade_needs_you_items WHERE needs_you_item_id = 'ny-1'
      `;
      assert.equal(rows[0]?.resolution_note_present, 0);
    }),
  );

  /**
   * The column's whole point is that it is *not* the value. A secret's length
   * is a real signal about the secret, so the type has to stay a flag rather
   * than drift into a length or a prefix the next time someone reaches for it.
   */
  it.effect("stores a flag, not a value", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const columns = yield* sql<{ name: string; type: string; notnull: number }>`
        PRAGMA table_info('ade_needs_you_items')
      `;
      const column = columns.find((entry) => entry.name === "resolution_note_present");
      assert.equal(column?.type, "INTEGER");
      assert.equal(column?.notnull, 1);
      // Nothing on this table can hold a note's contents.
      assert.notInclude(columns.map((entry) => entry.name).join(" "), "note_text");
    }),
  );
});
