// @effect-diagnostics nodeBuiltinImport:off
/**
 * ADE persona & memory service (spec `docs/ade/ADE-V1-SPEC.md` §4.3,
 * ADR §12.1–§12.2, issue #162).
 *
 * - `editPersona` appends a new captain-authored `PersonaVersion` with
 *   `activated_at = NULL`. Nothing else changes: the running session keeps
 *   its projection, and the pending version is activated by the session /
 *   rollover service the next time a session is created (ADR §12.1 —
 *   "persona edits take effect at the next session").
 * - `writeMemory` is the single write path for the bounded per-bot memory
 *   document. The S6 tool gate calls it with `author: "bot"` from the
 *   `update_memory` dynamic tool; captain edits call it with
 *   `author: "captain"`. The 65 536-unit bound
 *   (`MEMORY_DOCUMENT_MAX_LENGTH`, contracts) is enforced here, before SQL.
 * - Other bots can never write a bot's memory (ADR §12.2): attribution is a
 *   closed two-value union and the target is the explicit `botId` — the tool
 *   gate resolves `botId` structurally from the session-owning connection.
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type BotId,
  MEMORY_DOCUMENT_MAX_LENGTH,
  type MemoryDocument,
  type MemoryDocumentAuthor,
  PERSONA_CONTENT_MAX_LENGTH,
  type PersonaVersion,
  type PersonaVersionId,
} from "@shuv2code/contracts";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { AdeBotNotFoundError } from "./AdeBootstrap.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AdePersonaContentInvalidError extends Schema.TaggedErrorClass<AdePersonaContentInvalidError>()(
  "AdePersonaContentInvalidError",
  {
    botId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Persona content for bot '${this.botId}' is invalid: ${this.reason}`;
  }
}

export class AdeMemoryLimitExceededError extends Schema.TaggedErrorClass<AdeMemoryLimitExceededError>()(
  "AdeMemoryLimitExceededError",
  {
    botId: Schema.String,
    length: Schema.Number,
    limit: Schema.Number,
  },
) {
  override get message(): string {
    return `Memory document for bot '${this.botId}' is ${this.length} units; the bound is ${this.limit}.`;
  }
}

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

/**
 * Who may author a memory write. `system` is deliberately excluded: it marks
 * bootstrap seeds and is never a valid runtime author (contracts ade.ts).
 */
export type AdeMemoryWriteAuthor = Exclude<MemoryDocumentAuthor, "system">;

export interface WriteMemoryInput {
  readonly botId: BotId;
  readonly content: string;
  readonly author: AdeMemoryWriteAuthor;
}

export interface EditPersonaInput {
  readonly botId: BotId;
  readonly content: string;
}

export interface AdePersonaMemoryShape {
  /** Append a pending PersonaVersion; activation happens at next session. */
  readonly editPersona: (
    input: EditPersonaInput,
  ) => Effect.Effect<
    PersonaVersion,
    AdeBotNotFoundError | AdePersonaContentInvalidError | PersistenceSqlError
  >;
  readonly readMemory: (
    botId: BotId,
  ) => Effect.Effect<MemoryDocument, AdeBotNotFoundError | PersistenceSqlError>;
  /** The single write path for memory — tool-mediated (`bot`) or captain. */
  readonly writeMemory: (
    input: WriteMemoryInput,
  ) => Effect.Effect<
    MemoryDocument,
    AdeBotNotFoundError | AdeMemoryLimitExceededError | PersistenceSqlError
  >;
}

export class AdePersonaMemory extends Context.Service<AdePersonaMemory, AdePersonaMemoryShape>()(
  "shuv2code/ade/AdePersonaMemory",
) {
  static readonly layer = Layer.effect(
    AdePersonaMemory,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
      const uuid = Effect.sync(() => NodeCrypto.randomUUID());

      const requireBot = Effect.fn("AdePersonaMemory.requireBot")(function* (botId: BotId) {
        const rows = yield* sql<{ bot_id: string }>`
          SELECT bot_id FROM ade_bots WHERE bot_id = ${botId}
        `;
        if (rows.length === 0) return yield* new AdeBotNotFoundError({ botId });
      });

      const editPersona: AdePersonaMemoryShape["editPersona"] = Effect.fn(
        "AdePersonaMemory.editPersona",
      )(function* (input: EditPersonaInput) {
        const content = input.content;
        if (content.trim().length === 0) {
          return yield* new AdePersonaContentInvalidError({
            botId: input.botId,
            reason: "content must be non-empty",
          });
        }
        if (content.length > PERSONA_CONTENT_MAX_LENGTH) {
          return yield* new AdePersonaContentInvalidError({
            botId: input.botId,
            reason: `content is ${content.length} units; the bound is ${PERSONA_CONTENT_MAX_LENGTH}`,
          });
        }
        const personaVersionId = yield* uuid;
        const at = yield* nowIso;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* requireBot(input.botId);
              yield* sql`
                INSERT INTO ade_persona_versions (
                  persona_version_id, bot_id, content, created_at, activated_at
                ) VALUES (${personaVersionId}, ${input.botId}, ${content}, ${at}, NULL)
              `;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(toPersistenceSqlError("AdePersonaMemory.editPersona")(cause)),
            ),
          );
        return {
          id: personaVersionId as PersonaVersionId,
          botId: input.botId,
          content: content as PersonaVersion["content"],
          createdAt: at,
          activatedAt: null,
        } satisfies PersonaVersion;
      });

      const readMemory: AdePersonaMemoryShape["readMemory"] = Effect.fn(
        "AdePersonaMemory.readMemory",
      )(function* (botId: BotId) {
        const rows = yield* sql<{
          content: string;
          updated_at: string;
          updated_by: MemoryDocumentAuthor;
        }>`
          SELECT content, updated_at, updated_by FROM ade_memory_documents
          WHERE bot_id = ${botId}
        `.pipe(Effect.mapError(toPersistenceSqlError("AdePersonaMemory.readMemory")));
        const row = rows[0];
        if (row === undefined) return yield* new AdeBotNotFoundError({ botId });
        return {
          botId,
          content: row.content,
          updatedAt: row.updated_at,
          updatedBy: row.updated_by,
        } satisfies MemoryDocument;
      });

      const writeMemory: AdePersonaMemoryShape["writeMemory"] = Effect.fn(
        "AdePersonaMemory.writeMemory",
      )(function* (input: WriteMemoryInput) {
        if (input.content.length > MEMORY_DOCUMENT_MAX_LENGTH) {
          return yield* new AdeMemoryLimitExceededError({
            botId: input.botId,
            length: input.content.length,
            limit: MEMORY_DOCUMENT_MAX_LENGTH,
          });
        }
        const at = yield* nowIso;
        // Bootstrap seeds a memory row with every bot, so UPDATE is the
        // normal path; a missing row means the bot does not exist (the FK
        // would also reject the insert half of an upsert).
        const updated = yield* sql<{ bot_id: string }>`
          UPDATE ade_memory_documents
          SET content = ${input.content}, updated_at = ${at}, updated_by = ${input.author}
          WHERE bot_id = ${input.botId}
          RETURNING bot_id
        `.pipe(Effect.mapError(toPersistenceSqlError("AdePersonaMemory.writeMemory")));
        if (updated.length === 0) {
          return yield* new AdeBotNotFoundError({ botId: input.botId });
        }
        return {
          botId: input.botId,
          content: input.content,
          updatedAt: at,
          updatedBy: input.author,
        } satisfies MemoryDocument;
      });

      return AdePersonaMemory.of({ editPersona, readMemory, writeMemory });
    }),
  );
}
