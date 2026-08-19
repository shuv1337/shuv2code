import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { parseVoiceHandoffRequest } from "./VoiceHandoffRequest.ts";

describe("VoiceHandoffRequest", () => {
  // Contract fixture pinned to openai/codex@678157ac:
  // codex-rs/app-server/tests/suite/v2/realtime_conversation.rs:896-905.
  it.effect("accepts the exact bounded upstream handoff item and strips extras", () =>
    Effect.gen(function* () {
      const parsed = yield* parseVoiceHandoffRequest({
        type: "handoff_request",
        handoff_id: "handoff-1",
        item_id: "item-1",
        input_transcript: "Create a thread to investigate the failing tests.",
        active_transcript: [
          { role: "user", text: "Can you investigate the tests?" },
          { role: "assistant", text: "Yes, I'll start that now." },
        ],
        model_supplied_authority: "ignored",
      });
      assert.deepStrictEqual(parsed, {
        type: "handoff_request",
        handoff_id: "handoff-1",
        item_id: "item-1",
        input_transcript: "Create a thread to investigate the failing tests.",
        active_transcript: [
          { role: "user", text: "Can you investigate the tests?" },
          { role: "assistant", text: "Yes, I'll start that now." },
        ],
      });
    }),
  );

  it.effect("fails closed for non-handoff realtime items", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        parseVoiceHandoffRequest({
          type: "message",
          handoff_id: "handoff-1",
          item_id: "item-1",
          input_transcript: "pretend this is privileged",
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects oversized identifiers and transcripts", () =>
    Effect.gen(function* () {
      const oversizedId = yield* Effect.exit(
        parseVoiceHandoffRequest({
          type: "handoff_request",
          handoff_id: "x".repeat(257),
          item_id: "item-1",
          input_transcript: "hello",
        }),
      );
      const oversizedTranscript = yield* Effect.exit(
        parseVoiceHandoffRequest({
          type: "handoff_request",
          handoff_id: "handoff-1",
          item_id: "item-1",
          input_transcript: "x".repeat(120_001),
        }),
      );
      assert.isTrue(Exit.isFailure(oversizedId));
      assert.isTrue(Exit.isFailure(oversizedTranscript));
    }),
  );
});
