/**
 * `update_memory` handler (spec §4.3, ADR §12.2; issue #163).
 *
 * S8 built the single memory write path and S6 built the dispatch seam; this
 * is the two-line join between them that the tool gate needs to stop replying
 * "not yet available". Attribution is structural and non-negotiable: the
 * target bot is `ctx.botId`, which the gate resolved from the session-owning
 * connection, and the author is always `"bot"`. A bot therefore cannot name
 * another bot's memory document, and cannot forge a captain edit.
 *
 * `writeMemory` here is last-writer-wins on purpose (no `expectedUpdatedAt`):
 * the gate's re-request dedupe is in-memory only, so a replayed tool call must
 * be idempotent rather than conflict after a restart.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AdePersonaMemory } from "./AdePersonaMemory.ts";
import {
  AdeToolExecutionError,
  AdeToolHandlers,
  type AdeToolCallContext,
  type AdeToolHandlersShape,
  type UpdateMemoryInput,
} from "./AdeToolGate.ts";

export class AdeMemoryToolHandlers {
  /** Patch-style override so it stacks with the S7 assignment handlers. */
  static readonly layer: Layer.Layer<AdeToolHandlers, never, AdeToolHandlers | AdePersonaMemory> =
    Layer.effect(
      AdeToolHandlers,
      Effect.gen(function* () {
        const base = yield* AdeToolHandlers;
        const memory = yield* AdePersonaMemory;

        const updateMemory: AdeToolHandlersShape["updateMemory"] = (
          ctx: AdeToolCallContext,
          input: UpdateMemoryInput,
        ) =>
          memory.writeMemory({ botId: ctx.botId, content: input.content, author: "bot" }).pipe(
            Effect.map(
              (document) =>
                `Memory updated (${document.content.length} units, ${document.updatedAt}).`,
            ),
            Effect.mapError(
              (cause) => new AdeToolExecutionError({ tool: ctx.tool, detail: cause.message }),
            ),
          );

        return AdeToolHandlers.of({ ...base, updateMemory });
      }),
    );
}
