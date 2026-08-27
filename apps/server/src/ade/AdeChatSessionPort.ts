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

import {
  AdeCaptainError,
  type AdeBotChatSession,
  type AdeBotModelSetting,
  type AdeSetBotModelInput,
  type BotId,
} from "@shuv2code/contracts";

export interface AdeChatSessionPortShape {
  /**
   * Resolve — creating on first use — the bot's active primary-text session.
   * Idempotent: a second call while a session is active returns the same
   * binding with `startedNow: false` rather than rolling anything over
   * (rollover is an explicit, separate act, ADR §12.3).
   */
  readonly startPrimaryChat: (botId: BotId) => Effect.Effect<AdeBotChatSession, AdeCaptainError>;
  /**
   * Set the model this bot runs on.
   *
   * It lives on the port rather than on the captain API for the same reason
   * chat bootstrap does: the setting is written through an orchestration
   * command against the bot's thread and validated against the kernel's live
   * model catalog, and neither is reachable from a service that only owns
   * persistence.
   */
  readonly setBotModel: (
    input: AdeSetBotModelInput,
  ) => Effect.Effect<AdeBotModelSetting, AdeCaptainError>;
  /**
   * Which model this bot is currently set to run on, or null when nothing has
   * chosen one yet. A pure read: it never creates a thread, and it never
   * fails, because the bot detail payload it feeds must keep rendering while
   * the kernel is down.
   */
  readonly readBotModelSlug: (botId: BotId) => Effect.Effect<string | null>;
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
  setBotModel: () =>
    Effect.fail(
      new AdeCaptainError({
        reason: "session_unavailable",
        message:
          "No execution kernel is wired for ADE chat in this build, so there are no models to choose from.",
      }),
    ),
  readBotModelSlug: () => Effect.succeed(null),
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
