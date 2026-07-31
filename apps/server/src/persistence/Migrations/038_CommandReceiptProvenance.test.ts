import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_CommandReceiptProvenance", (it) => {
  it.effect("keeps legacy receipts readable and persists trusted canonical provenance", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          error
        )
        VALUES (
          'legacy-command',
          'thread',
          'thread-1',
          '2026-07-30T00:00:00.000Z',
          1,
          'accepted',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });

      const legacy = yield* sql<{
        readonly commandType: string | null;
        readonly canonicalCommandHash: string | null;
        readonly actorProvenanceJson: string | null;
      }>`
        SELECT
          command_type AS "commandType",
          canonical_command_hash AS "canonicalCommandHash",
          actor_provenance_json AS "actorProvenanceJson"
        FROM orchestration_command_receipts
        WHERE command_id = 'legacy-command'
      `;
      assert.deepStrictEqual(legacy[0], {
        commandType: null,
        canonicalCommandHash: null,
        actorProvenanceJson: null,
      });

      yield* sql`
        UPDATE orchestration_command_receipts
        SET
          command_type = 'thread.turn.steer',
          canonical_command_hash = 'sha256:command',
          actor_provenance_json =
            '{"actorKind":"voice-controller","voiceActionId":"action-1"}'
        WHERE command_id = 'legacy-command'
      `;
      const canonical = yield* sql<{
        readonly commandType: string;
        readonly canonicalCommandHash: string;
        readonly actorProvenanceJson: string;
      }>`
        SELECT
          command_type AS "commandType",
          canonical_command_hash AS "canonicalCommandHash",
          actor_provenance_json AS "actorProvenanceJson"
        FROM orchestration_command_receipts
        WHERE command_id = 'legacy-command'
      `;
      assert.deepStrictEqual(canonical[0], {
        commandType: "thread.turn.steer",
        canonicalCommandHash: "sha256:command",
        actorProvenanceJson: '{"actorKind":"voice-controller","voiceActionId":"action-1"}',
      });
    }),
  );
});
