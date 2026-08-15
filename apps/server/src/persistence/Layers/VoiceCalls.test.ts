import { EnvironmentId, ThreadId, VoiceCallId, VoiceCallRevision } from "@shuv2code/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { VoiceCallRepositoryLive } from "./VoiceCalls.ts";
import { VoiceCallRepository } from "../Services/VoiceCalls.ts";

const layer = it.layer(VoiceCallRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("VoiceCallRepository", (it) => {
  it.effect("fences listener ownership with a monotonic revision", () =>
    Effect.gen(function* () {
      const calls = yield* VoiceCallRepository;
      const callId = VoiceCallId.make("call-1");
      const environmentId = EnvironmentId.make("environment-1");
      const threadId = ThreadId.make("thread-1");
      const created = yield* calls.create({
        callId,
        environmentId,
        threadId,
        activeTransportSessionId: "transport-1",
        activeDevice: { deviceId: "desktop-1", label: "Desktop", kind: "desktop" },
        createdAt: "2026-08-15T23:00:00.000Z",
      });
      assert.strictEqual(created._tag, "created");

      const stale = yield* calls.compareAndSetListener({
        callId,
        expectedRevision: VoiceCallRevision.make(2),
        expectedActiveTransportSessionId: "transport-1",
        threadId,
        state: "active",
        activeTransportSessionId: "transport-2",
        activeDevice: { deviceId: "mobile-1", label: "Phone", kind: "mobile" },
        updatedAt: "2026-08-15T23:01:00.000Z",
        endedAt: null,
      });
      assert.isTrue(Option.isNone(stale));

      const moved = yield* calls.compareAndSetListener({
        callId,
        expectedRevision: VoiceCallRevision.make(1),
        expectedActiveTransportSessionId: "transport-1",
        threadId,
        state: "active",
        activeTransportSessionId: "transport-2",
        activeDevice: { deviceId: "mobile-1", label: "Phone", kind: "mobile" },
        updatedAt: "2026-08-15T23:01:00.000Z",
        endedAt: null,
      });
      assert.isTrue(Option.isSome(moved));
      assert.strictEqual(Option.getOrThrow(moved).revision, 2);
      assert.strictEqual(Option.getOrThrow(moved).activeDeviceKind, "mobile");
    }),
  );
});
