import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  VoiceActionId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import {
  controllerActionStartRequest,
  controllerTranscriptWithActiveTarget,
  deriveVoiceActionId,
  runSerializedVoiceActions,
} from "./voiceControllerShared.ts";

describe("VoiceControllerActionRunner ownership", () => {
  it.effect("deduplicates handoff tuples into one durable action id", () =>
    Effect.gen(function* () {
      const identity = {
        environmentId: EnvironmentId.make("environment"),
        transportSessionId: "transport:generation:1",
        generation: 1,
        handoffId: "handoff-1",
        itemId: "item-1",
      };
      const first = yield* deriveVoiceActionId(identity);
      const replay = yield* deriveVoiceActionId(identity);
      assert.strictEqual(first, replay);
      const request = controllerActionStartRequest({
        controllerThreadId: ThreadId.make("controller"),
        controllerRuntimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
        voiceActionId: first,
        transcript: "Do the work.",
      });
      assert.strictEqual(request.clientUserMessageId, first);
      assert.strictEqual(request.recoveryPolicy, "forbid");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("serializes controller actions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<number>();
        const active = yield* Ref.make(0);
        const maxActive = yield* Ref.make(0);
        const completed = yield* Queue.unbounded<number>();
        const worker = yield* runSerializedVoiceActions(queue, (value) =>
          Effect.gen(function* () {
            const current = yield* Ref.updateAndGet(active, (count) => count + 1);
            yield* Ref.update(maxActive, (maximum) => Math.max(maximum, current));
            yield* Effect.yieldNow;
            yield* Ref.update(active, (count) => count - 1);
            yield* Queue.offer(completed, value);
          }),
        ).pipe(Effect.forkScoped);
        yield* Queue.offerAll(queue, [1, 2, 3]);
        assert.deepStrictEqual(
          [
            yield* Queue.take(completed),
            yield* Queue.take(completed),
            yield* Queue.take(completed),
          ],
          [1, 2, 3],
        );
        assert.strictEqual(yield* Ref.get(maxActive), 1);
        yield* Queue.shutdown(queue);
        yield* Fiber.await(worker);
      }),
    ),
  );

  it("injects only a bounded active-target hint into controller input", () => {
    const text = controllerTranscriptWithActiveTarget("status?", ThreadId.make("target-1"));
    assert.include(text, 'activeTargetThreadId="target-1"');
    assert.include(text, "status?");
    assert.strictEqual(controllerTranscriptWithActiveTarget("status?", null), "status?");
    void VoiceActionId.make("unused");
  });
});
