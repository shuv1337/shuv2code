import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { runVoiceTransportFeedback } from "./VoiceTransportFeedback.ts";

it.effect("bounds a realtime feedback call that never settles", () =>
  Effect.gen(function* () {
    const feedback = yield* runVoiceTransportFeedback(Effect.never).pipe(
      Effect.as("released"),
      Effect.forkChild,
    );
    yield* TestClock.adjust("3 seconds");
    assert.strictEqual(yield* Fiber.join(feedback), "released");
  }),
);
