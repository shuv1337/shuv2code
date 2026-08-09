import * as Effect from "effect/Effect";

export const VOICE_TRANSPORT_FEEDBACK_TIMEOUT = "3 seconds" as const;

/**
 * Realtime text and speech are advisory feedback. A stale or wedged provider
 * transport must never hold the authoritative voice action queue open.
 */
export const runVoiceTransportFeedback = <A, E, R>(
  feedback: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R> =>
  feedback.pipe(Effect.timeout(VOICE_TRANSPORT_FEEDBACK_TIMEOUT), Effect.ignore);
