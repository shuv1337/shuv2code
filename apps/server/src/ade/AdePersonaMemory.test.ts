import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type BotId,
  MEMORY_DOCUMENT_MAX_LENGTH,
  PERSONA_CONTENT_MAX_LENGTH,
} from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdePersonaMemory } from "./AdePersonaMemory.ts";

const makeLayer = () =>
  Layer.mergeAll(AdeBootstrap.layer, AdePersonaMemory.layer).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  );

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;
  const bootstrap = yield* AdeBootstrap;
  const seeded = yield* bootstrap.ensureSeeded();
  return { sql, bootstrap, service: yield* AdePersonaMemory, botId: seeded.firstmateBotId };
});

describe("AdePersonaMemory.writeMemory", () => {
  it.effect("attributes tool-mediated writes to the bot and captain edits to the captain", () =>
    Effect.gen(function* () {
      const { sql, service, botId } = yield* setup;

      // Tool-mediated write (what the S6 update_memory handler calls).
      const botWrite = yield* service.writeMemory({
        botId,
        content: "Prefers jj over git.",
        author: "bot",
      });
      assert.equal(botWrite.updatedBy, "bot");
      assert.equal(botWrite.content, "Prefers jj over git.");

      let rows = yield* sql<{ content: string; updated_by: string }>`
        SELECT content, updated_by FROM ade_memory_documents WHERE bot_id = ${botId}
      `;
      assert.deepEqual(rows[0], { content: "Prefers jj over git.", updated_by: "bot" });

      // Captain edit through the same single write path.
      const captainWrite = yield* service.writeMemory({
        botId,
        content: "Prefers jj over git. Ask before force-pushing.",
        author: "captain",
      });
      assert.equal(captainWrite.updatedBy, "captain");

      rows = yield* sql<{ content: string; updated_by: string }>`
        SELECT content, updated_by FROM ade_memory_documents WHERE bot_id = ${botId}
      `;
      assert.lengthOf(rows, 1); // still one document per bot (1:1)
      assert.deepEqual(rows[0], {
        content: "Prefers jj over git. Ask before force-pushing.",
        updated_by: "captain",
      });

      const read = yield* service.readMemory(botId);
      assert.equal(read.updatedBy, "captain");
      assert.equal(read.content, "Prefers jj over git. Ask before force-pushing.");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("enforces the 65_536-unit memory bound from contracts", () =>
    Effect.gen(function* () {
      const { sql, service, botId } = yield* setup;

      // Exactly at the bound is accepted…
      const atLimit = "m".repeat(MEMORY_DOCUMENT_MAX_LENGTH);
      const ok = yield* service.writeMemory({ botId, content: atLimit, author: "bot" });
      assert.equal(ok.content.length, 65_536);

      // …one unit over is refused, and the stored document is untouched.
      const refusal = yield* Effect.flip(
        service.writeMemory({
          botId,
          content: "m".repeat(MEMORY_DOCUMENT_MAX_LENGTH + 1),
          author: "captain",
        }),
      );
      assert.equal(refusal._tag, "AdeMemoryLimitExceededError");
      assert.include(refusal.message, "65536");

      const rows = yield* sql<{ length: number; updated_by: string }>`
        SELECT length(content) AS length, updated_by FROM ade_memory_documents
        WHERE bot_id = ${botId}
      `;
      assert.deepEqual(rows[0], { length: 65_536, updated_by: "bot" });

      // The DB-side CHECK backstops the bound even for raw writes.
      const rawOverBound = yield* Effect.exit(sql`
        UPDATE ade_memory_documents
        SET content = ${"m".repeat(MEMORY_DOCUMENT_MAX_LENGTH + 1)}
        WHERE bot_id = ${botId}
      `);
      assert.isTrue(Exit.isFailure(rawOverBound));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("supports an optional updatedAt precondition (CAS) for writes", () =>
    Effect.gen(function* () {
      const { service, botId } = yield* setup;

      yield* service.writeMemory({ botId, content: "v1", author: "bot" });
      const current = yield* service.readMemory(botId);

      // Matching precondition lands.
      const ok = yield* service.writeMemory({
        botId,
        content: "v2",
        author: "captain",
        expectedUpdatedAt: current.updatedAt,
      });
      assert.equal(ok.content, "v2");

      // Stale precondition is refused and the document is untouched.
      const conflict = yield* Effect.flip(
        service.writeMemory({
          botId,
          content: "v3-lost",
          author: "bot",
          expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
        }),
      );
      assert.equal(conflict._tag, "AdeMemoryConflictError");
      if (conflict._tag !== "AdeMemoryConflictError") {
        return assert.fail("expected AdeMemoryConflictError");
      }
      assert.equal(conflict.expectedUpdatedAt, "2000-01-01T00:00:00.000Z");
      assert.equal(conflict.actualUpdatedAt, ok.updatedAt);

      const after = yield* service.readMemory(botId);
      assert.equal(after.content, "v2");
      assert.equal(after.updatedBy, "captain");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses writes and reads for unknown bots", () =>
    Effect.gen(function* () {
      const { service } = yield* setup;
      const write = yield* Effect.flip(
        service.writeMemory({ botId: "nope" as BotId, content: "x", author: "bot" }),
      );
      assert.equal(write._tag, "AdeBotNotFoundError");
      const read = yield* Effect.flip(service.readMemory("nope" as BotId));
      assert.equal(read._tag, "AdeBotNotFoundError");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdePersonaMemory.editPersona", () => {
  it.effect("appends a pending version without touching the active persona", () =>
    Effect.gen(function* () {
      const { sql, service, botId } = yield* setup;

      const before = yield* sql<{ active_persona_version_id: string | null }>`
        SELECT active_persona_version_id FROM ade_bots WHERE bot_id = ${botId}
      `;
      const activeBefore = before[0]!.active_persona_version_id;
      assert.isNotNull(activeBefore);

      const edited = yield* service.editPersona({ botId, content: "You are terse." });
      assert.isNull(edited.activatedAt);
      assert.equal(edited.content, "You are terse.");

      // The edit is durable but pending: activation belongs to the next
      // session creation (ADR §12.1), so the bot's active pointer is unmoved.
      const versions = yield* sql<{ persona_version_id: string; activated_at: string | null }>`
        SELECT persona_version_id, activated_at FROM ade_persona_versions
        WHERE bot_id = ${botId} ORDER BY created_at ASC, rowid ASC
      `;
      assert.lengthOf(versions, 2);
      assert.isNotNull(versions[0]!.activated_at);
      assert.isNull(versions[1]!.activated_at);
      assert.equal(versions[1]!.persona_version_id, edited.id);

      const after = yield* sql<{ active_persona_version_id: string | null }>`
        SELECT active_persona_version_id FROM ade_bots WHERE bot_id = ${botId}
      `;
      assert.equal(after[0]!.active_persona_version_id, activeBefore);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses empty and over-bound persona content, and unknown bots", () =>
    Effect.gen(function* () {
      const { service, botId } = yield* setup;

      const empty = yield* Effect.flip(service.editPersona({ botId, content: "   " }));
      assert.equal(empty._tag, "AdePersonaContentInvalidError");

      const overBound = yield* Effect.flip(
        service.editPersona({ botId, content: "p".repeat(PERSONA_CONTENT_MAX_LENGTH + 1) }),
      );
      assert.equal(overBound._tag, "AdePersonaContentInvalidError");

      const missing = yield* Effect.flip(
        service.editPersona({ botId: "nope" as BotId, content: "hello" }),
      );
      assert.equal(missing._tag, "AdeBotNotFoundError");
    }).pipe(Effect.provide(makeLayer())),
  );
});
