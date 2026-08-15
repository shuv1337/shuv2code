import {
  EnvironmentId,
  ThreadId,
  VoiceCallId,
  VoiceCallRevision,
  VoiceDeviceId,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { VoiceCallRepositoryLive } from "./VoiceCalls.ts";
import { VoiceCallRepository } from "../Services/VoiceCalls.ts";
import { VoiceTransportSessionRepositoryLive } from "./VoiceTransportSessions.ts";
import { VoiceTransportSessionRepository } from "../Services/VoiceTransportSessions.ts";

const layer = it.layer(
  Layer.mergeAll(VoiceCallRepositoryLive, VoiceTransportSessionRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

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
        activeDevice: {
          deviceId: VoiceDeviceId.make("desktop-1"),
          label: "Desktop",
          kind: "desktop",
        },
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
        activeDevice: {
          deviceId: VoiceDeviceId.make("mobile-1"),
          label: "Phone",
          kind: "mobile",
        },
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
        activeDevice: {
          deviceId: VoiceDeviceId.make("mobile-1"),
          label: "Phone",
          kind: "mobile",
        },
        updatedAt: "2026-08-15T23:01:00.000Z",
        endedAt: null,
      });
      assert.isTrue(Option.isSome(moved));
      assert.strictEqual(Option.getOrThrow(moved).revision, 2);
      assert.strictEqual(Option.getOrThrow(moved).activeDeviceKind, "mobile");
    }),
  );

  it.effect("promotes a negotiated listener and fences the previous transport atomically", () =>
    Effect.gen(function* () {
      const calls = yield* VoiceCallRepository;
      const transports = yield* VoiceTransportSessionRepository;
      const callId = VoiceCallId.make("call-handoff");
      const environmentId = EnvironmentId.make("environment-handoff");
      const threadId = ThreadId.make("thread-handoff");
      const owner = { kind: "thread-call" as const, threadId };
      const desktopRuntime = VoiceRuntimeInstanceId.make("runtime-desktop");
      const desktopRealtime = VoiceRealtimeSessionId.make("realtime-desktop");
      const mobileRuntime = VoiceRuntimeInstanceId.make("runtime-mobile");
      const mobileRealtime = VoiceRealtimeSessionId.make("realtime-mobile");

      yield* transports.openOrReplay({
        transportSessionId: "transport-desktop",
        environmentId,
        callId,
        device: {
          deviceId: VoiceDeviceId.make("desktop-1"),
          label: "Desktop",
          kind: "desktop",
        },
        owner,
        controllerThreadId: threadId,
        transportThreadId: ThreadId.make("transport-thread-desktop"),
        runtimeInstanceId: desktopRuntime,
        generation: VoiceGeneration.make(1),
        createdAt: "2026-08-16T01:00:00.000Z",
      });
      assert.isTrue(
        yield* transports.activate({
          transportSessionId: "transport-desktop",
          generation: VoiceGeneration.make(1),
          runtimeInstanceId: desktopRuntime,
          realtimeSessionId: desktopRealtime,
          updatedAt: "2026-08-16T01:00:01.000Z",
        }),
      );
      yield* calls.create({
        callId,
        environmentId,
        threadId,
        activeTransportSessionId: "transport-desktop",
        activeDevice: {
          deviceId: VoiceDeviceId.make("desktop-1"),
          label: "Desktop",
          kind: "desktop",
        },
        createdAt: "2026-08-16T01:00:01.000Z",
      });
      yield* transports.openHandoffOrReplay({
        transportSessionId: "transport-mobile",
        environmentId,
        callId,
        device: {
          deviceId: VoiceDeviceId.make("mobile-1"),
          label: "Phone",
          kind: "mobile",
        },
        owner,
        controllerThreadId: threadId,
        transportThreadId: ThreadId.make("transport-thread-mobile"),
        runtimeInstanceId: mobileRuntime,
        generation: VoiceGeneration.make(1),
        createdAt: "2026-08-16T01:01:00.000Z",
      });

      const promoted = yield* calls.promoteListener({
        callId,
        expectedRevision: VoiceCallRevision.make(1),
        expectedActiveTransportSessionId: "transport-desktop",
        nextTransportSessionId: "transport-mobile",
        nextGeneration: VoiceGeneration.make(1),
        nextRuntimeInstanceId: mobileRuntime,
        nextRealtimeSessionId: mobileRealtime,
        threadId,
        activeDevice: {
          deviceId: VoiceDeviceId.make("mobile-1"),
          label: "Phone",
          kind: "mobile",
        },
        updatedAt: "2026-08-16T01:01:01.000Z",
      });

      assert.isTrue(Option.isSome(promoted));
      assert.strictEqual(Option.getOrThrow(promoted).revision, 2);
      assert.strictEqual(Option.getOrThrow(promoted).activeDeviceKind, "mobile");
      assert.strictEqual(
        Option.getOrThrow(yield* transports.getById("transport-desktop")).state,
        "fenced",
      );
      assert.strictEqual(
        Option.getOrThrow(yield* transports.getById("transport-mobile")).state,
        "active",
      );
    }),
  );
});
