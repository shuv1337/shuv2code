import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const HandoffId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const HandoffTranscript = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(120_000));
const ActiveTranscriptEntry = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(16_384)),
});

/**
 * Exact client-managed handoff item emitted by Codex realtime v3.
 *
 * Pinned upstream evidence:
 * openai/codex@678157ac
 * codex-rs/app-server/tests/suite/v2/realtime_conversation.rs:896-905
 *
 * This parser is the privilege boundary between an untrusted raw realtime
 * item and durable controller action creation. No other item type may enqueue
 * a controller turn.
 */
export const VoiceHandoffRequest = Schema.Struct({
  type: Schema.Literal("handoff_request"),
  handoff_id: HandoffId,
  item_id: HandoffId,
  input_transcript: HandoffTranscript,
  active_transcript: Schema.optionalKey(
    Schema.Array(ActiveTranscriptEntry).check(Schema.isMaxLength(64)),
  ),
});
export type VoiceHandoffRequest = typeof VoiceHandoffRequest.Type;

const decodeVoiceHandoffRequest = Schema.decodeUnknownEffect(VoiceHandoffRequest);

export class VoiceHandoffRequestDecodeError extends Schema.TaggedErrorClass<VoiceHandoffRequestDecodeError>()(
  "VoiceHandoffRequestDecodeError",
  {
    message: Schema.String,
  },
) {}

export const parseVoiceHandoffRequest = Effect.fn("VoiceHandoffRequest.parse")(function* (
  input: unknown,
) {
  return yield* decodeVoiceHandoffRequest(input).pipe(
    Effect.mapError(
      () =>
        new VoiceHandoffRequestDecodeError({
          message: "Realtime item is not a valid bounded handoff request.",
        }),
    ),
  );
});
