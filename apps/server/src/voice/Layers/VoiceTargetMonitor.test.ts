import { assert, describe, it } from "@effect/vitest";
import { ThreadId, VoiceActionId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  claimVoiceTargetPhase,
  targetPhaseOf,
  targetThreadIdFromVoiceMutation,
  voiceTargetStatusText,
} from "./voiceControllerShared.ts";

describe("VoiceTargetMonitor ownership", () => {
  it.effect("coalesces duplicate phases per transport/action/target key", () =>
    Effect.gen(function* () {
      const phases = yield* Ref.make(new Map());
      const watch = {
        voiceActionId: VoiceActionId.make("action-1"),
        transportSessionId: "transport-1",
        targetThreadId: ThreadId.make("target-1"),
      };
      assert.strictEqual(yield* claimVoiceTargetPhase(phases, watch, "working"), true);
      assert.strictEqual(yield* claimVoiceTargetPhase(phases, watch, "working"), false);
      assert.strictEqual(yield* claimVoiceTargetPhase(phases, watch, "completed"), true);
    }),
  );

  it("maps mutation slots to target thread ids without transport ownership", () => {
    assert.strictEqual(
      targetThreadIdFromVoiceMutation({
        voiceActionId: "action-create",
        toolName: "thread_create",
        semanticSlot: "create:project",
      }),
      "voice:action-create:thread",
    );
  });

  it("derives bounded status text from shell phase", () => {
    assert.include(
      voiceTargetStatusText({
        projectTitle: "demo",
        threadTitle: "work",
        phase: "working",
      }),
      "working",
    );
    assert.strictEqual(
      targetPhaseOf({
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        session: { status: "running" },
        latestTurn: { state: "running" },
      } as never),
      "working",
    );
  });
});
