/**
 * ADE chat session port (spec `docs/ade/ADE-V1-SPEC.md` §7 slice 1, §4.3).
 *
 * Resolving a bot's chat means resolving its **primary-text**
 * `BotExecutionBinding` — the one live kernel session ADR §3.2 allows per bot
 * — and reporting the shuv2code thread that renders it. That is deliberately a
 * port rather than a method on the captain API: everything else the captain
 * surface does is persistence, while this reaches into the provider runtime
 * (thread create, session start, tool-gate attach) and must stay swappable for
 * tests and for builds with no kernel wired.
 *
 * The live implementation lives in {@link AdeShuvcodeChatSession}.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AdeCaptainError, type AdeBotChatSession, type BotId } from "@shuv2code/contracts";

export interface AdeChatSessionPortShape {
  /**
   * Resolve — creating on first use — the bot's active primary-text session.
   * Idempotent: a second call while a session is active returns the same
   * binding with `startedNow: false` rather than rolling anything over
   * (rollover is an explicit, separate act, ADR §12.3).
   */
  readonly startPrimaryChat: (botId: BotId) => Effect.Effect<AdeBotChatSession, AdeCaptainError>;
}

/**
 * Default when no kernel is wired: chat is unavailable, but every other
 * captain surface (roster, bot detail, memory, persona) keeps working —
 * spec §4.1 is explicit that the app stays fully navigable while degraded.
 */
export const adeChatSessionPortUnavailable: AdeChatSessionPortShape = {
  startPrimaryChat: () =>
    Effect.fail(
      new AdeCaptainError({
        reason: "session_unavailable",
        message: "No execution kernel is wired for ADE chat in this build.",
      }),
    ),
};

export class AdeChatSessionPort extends Context.Service<
  AdeChatSessionPort,
  AdeChatSessionPortShape
>()("shuv2code/ade/AdeChatSessionPort") {
  static readonly layerUnavailable = Layer.succeed(
    AdeChatSessionPort,
    adeChatSessionPortUnavailable,
  );
}
