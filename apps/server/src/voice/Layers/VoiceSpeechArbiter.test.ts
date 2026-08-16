import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceClientSessionId,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
  VoiceTranscriptItemId,
} from "@shuv2code/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type { VoiceSpeechSource } from "../Services/VoiceSpeechArbiter.ts";
import type { ActiveVoiceSession } from "../Services/VoiceTransportCoordinator.ts";
import { makeVoiceSpeechArbiter } from "./VoiceSpeechArbiter.ts";

const session = (generation = 1): ActiveVoiceSession => ({
  transportSessionId: `call-client:${generation}`,
  fence: {
    environmentId: EnvironmentId.make("environment"),
    owner: { kind: "thread-call", threadId: ThreadId.make("thread") },
    controllerThreadId: ThreadId.make("thread"),
    transportThreadId: ThreadId.make("transport"),
    clientSessionId: VoiceClientSessionId.make("call-client"),
    generation: VoiceGeneration.make(generation),
    runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
    realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
  },
  environmentId: EnvironmentId.make("environment"),
  hostProjectId: ProjectId.make("project"),
  transportProviderInstanceId: ProviderInstanceId.make("codex"),
  controller: null,
  controllerRuntime: null,
  call: null,
  transportType: "webrtc",
  purpose: "conversation",
  answerSdp: "answer",
  lastAudioSequence: 0,
  eventCursor: 0,
  history: [],
});

const attempt = (
  activeSession: ActiveVoiceSession,
  attemptId: string,
  source: VoiceSpeechSource,
  requestedText: string,
) => ({
  attemptId,
  source,
  session: activeSession,
  threadId: ThreadId.make("thread"),
  turnId: null,
  requestedText,
  requestedAt: "2026-08-15T00:00:00.000Z",
});

describe("VoiceSpeechArbiter", () => {
  it.effect("serializes speech and lets authored narration displace queued ambient work", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<Array<string>>([]);
      const arbiter = yield* makeVoiceSpeechArbiter((speech) =>
        Ref.update(sent, (all) => [...all, speech.requestedText]),
      );
      const activeSession = session();

      assert.strictEqual(
        yield* arbiter.enqueue(attempt(activeSession, "ambient-1", "ambient", "First check.")),
        true,
      );
      assert.strictEqual(
        yield* arbiter.enqueue(
          attempt(activeSession, "ambient-duplicate", "ambient", " first  check. "),
        ),
        false,
      );
      assert.strictEqual(
        yield* arbiter.enqueue(attempt(activeSession, "ambient-2", "ambient", "Second check.")),
        true,
      );
      assert.strictEqual(
        yield* arbiter.enqueue(attempt(activeSession, "authored-1", "authored", "I found it.")),
        true,
      );
      assert.strictEqual(
        yield* arbiter.enqueue(
          attempt(activeSession, "controller-1", "controller", "The target changed."),
        ),
        true,
      );
      assert.deepStrictEqual(yield* Ref.get(sent), ["First check."]);

      const first = yield* arbiter.observeTranscript({
        session: activeSession,
        itemId: VoiceTranscriptItemId.make("provider-ambient"),
        text: "The first check is running.",
        occurredAt: "2026-08-15T00:00:01.000Z",
        outputDone: true,
      });
      assert.strictEqual(first.claimed, true);
      assert.strictEqual(first.completion?.source, "ambient");
      assert.deepStrictEqual(yield* Ref.get(sent), ["First check.", "I found it."]);

      const authored = yield* arbiter.observeTranscript({
        session: activeSession,
        itemId: VoiceTranscriptItemId.make("provider-authored"),
        text: "I actually found the root cause.",
        occurredAt: "2026-08-15T00:00:02.000Z",
        outputDone: true,
      });
      assert.strictEqual(authored.completion?.requestedText, "I found it.");
      assert.strictEqual(authored.completion?.deliveredText, "I actually found the root cause.");
      assert.deepStrictEqual(yield* Ref.get(sent), [
        "First check.",
        "I found it.",
        "The target changed.",
      ]);

      const controller = yield* arbiter.observeTranscript({
        session: activeSession,
        itemId: VoiceTranscriptItemId.make("provider-controller"),
        text: "The target has changed.",
        occurredAt: "2026-08-15T00:00:03.000Z",
        outputDone: true,
      });
      assert.strictEqual(controller.completion?.source, "controller");
    }),
  );

  it.effect("waits for native realtime output before starting app-injected speech", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<Array<string>>([]);
      const arbiter = yield* makeVoiceSpeechArbiter((speech) =>
        Ref.update(sent, (all) => [...all, speech.requestedText]),
      );
      const activeSession = session();

      yield* arbiter.observeUserSpeech(activeSession);
      yield* arbiter.enqueue(attempt(activeSession, "authored-1", "authored", "My update."));
      assert.deepStrictEqual(yield* Ref.get(sent), []);

      const native = yield* arbiter.observeTranscript({
        session: activeSession,
        itemId: VoiceTranscriptItemId.make("native-ack"),
        text: "I’ll check that now.",
        occurredAt: "2026-08-15T00:00:01.000Z",
        outputDone: true,
      });
      assert.strictEqual(native.claimed, false);
      assert.deepStrictEqual(yield* Ref.get(sent), ["My update."]);
    }),
  );

  it.effect("keeps streamed commentary ordered and drops it on user barge-in", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<Array<string>>([]);
      const arbiter = yield* makeVoiceSpeechArbiter((speech) =>
        Ref.update(sent, (all) => [...all, speech.requestedText]),
      );
      const activeSession = session();

      yield* arbiter.enqueue(
        attempt(activeSession, "commentary-1", "commentary", "First two sentences."),
      );
      yield* arbiter.enqueue(
        attempt(activeSession, "commentary-2", "commentary", "The next update."),
      );
      yield* arbiter.enqueue(
        attempt(activeSession, "commentary-duplicate", "commentary", " the next update. "),
      );
      assert.deepStrictEqual(yield* Ref.get(sent), ["First two sentences."]);

      yield* arbiter.observeUserSpeech(activeSession);
      yield* arbiter.observeTranscript({
        session: activeSession,
        itemId: VoiceTranscriptItemId.make("provider-commentary"),
        text: "First two sentences.",
        occurredAt: "2026-08-15T00:00:01.000Z",
        outputDone: true,
      });
      assert.deepStrictEqual(yield* Ref.get(sent), ["First two sentences."]);
    }),
  );

  it.effect("does not replay a queued rejoin catch-up after user barge-in", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<Array<string>>([]);
      const arbiter = yield* makeVoiceSpeechArbiter((speech) =>
        Ref.update(sent, (all) => [...all, speech.requestedText]),
      );
      const activeSession = session();

      yield* arbiter.enqueue(attempt(activeSession, "authored-1", "authored", "Live update."));
      yield* arbiter.enqueue(
        attempt(activeSession, "catch-up-1", "catch-up", "While you were away."),
      );
      yield* arbiter.observeUserSpeech(activeSession);
      yield* arbiter.observeTranscript({
        session: activeSession,
        itemId: VoiceTranscriptItemId.make("provider-live"),
        text: "Live upd—",
        occurredAt: "2026-08-15T00:00:01.000Z",
        outputDone: true,
      });

      assert.deepStrictEqual(yield* Ref.get(sent), ["Live update."]);
    }),
  );

  it.effect("waits for output completion after receiving an early provider transcript", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<Array<string>>([]);
      const arbiter = yield* makeVoiceSpeechArbiter((speech) =>
        Ref.update(sent, (all) => [...all, speech.requestedText]),
      );
      const activeSession = session();

      yield* arbiter.enqueue(attempt(activeSession, "authored-1", "authored", "First."));
      yield* arbiter.enqueue(attempt(activeSession, "authored-2", "authored", "Second."));
      const transcript = yield* arbiter.observeTranscript({
        session: activeSession,
        itemId: VoiceTranscriptItemId.make("provider-first"),
        text: "Delivered first.",
        occurredAt: "2026-08-15T00:00:01.000Z",
        outputDone: false,
      });
      assert.strictEqual(transcript.claimed, true);
      assert.isUndefined(transcript.completion);
      assert.deepStrictEqual(yield* Ref.get(sent), ["First."]);

      const completion = yield* arbiter.observeOutputDone(
        activeSession,
        "2026-08-15T00:00:02.000Z",
      );
      assert.strictEqual(completion?.deliveredText, "Delivered first.");
      assert.deepStrictEqual(yield* Ref.get(sent), ["First.", "Second."]);
    }),
  );

  it.effect("keeps an attempt active when its transport acknowledgement times out", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<Array<string>>([]);
      const firstStarted = yield* Deferred.make<void>();
      const arbiter = yield* makeVoiceSpeechArbiter((speech) =>
        Ref.update(sent, (all) => [...all, speech.requestedText]).pipe(
          Effect.andThen(
            speech.attemptId === "authored-1"
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Effect.never as Effect.Effect<void>),
                )
              : Effect.void,
          ),
        ),
      );
      const activeSession = session();

      const firstEnqueue = yield* arbiter
        .enqueue(attempt(activeSession, "authored-1", "authored", "First."))
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      assert.strictEqual(
        yield* arbiter.enqueue(attempt(activeSession, "authored-2", "authored", "Second.")),
        true,
      );

      yield* TestClock.adjust("3 seconds");
      assert.strictEqual(yield* Fiber.join(firstEnqueue), true);
      assert.deepStrictEqual(yield* Ref.get(sent), ["First."]);

      yield* arbiter.observeTranscript({
        session: activeSession,
        itemId: VoiceTranscriptItemId.make("provider-first"),
        text: "Delivered first.",
        occurredAt: "2026-08-15T00:00:01.000Z",
        outputDone: true,
      });
      assert.deepStrictEqual(yield* Ref.get(sent), ["First.", "Second."]);
    }),
  );

  it.effect("accepts late output without requiring an output-start signal", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<Array<string>>([]);
      const lifecycle = yield* Ref.make<Array<string>>([]);
      const arbiter = yield* makeVoiceSpeechArbiter(
        (speech) => Ref.update(sent, (all) => [...all, speech.requestedText]),
        (event) =>
          Ref.update(lifecycle, (all) => [...all, `${event.attempt.attemptId}:${event.kind}`]),
      );
      const activeSession = session();

      yield* arbiter.enqueue(attempt(activeSession, "authored-1", "authored", "First."));
      yield* arbiter.enqueue(attempt(activeSession, "authored-2", "authored", "Second."));

      yield* TestClock.adjust("9 seconds");
      yield* Effect.yieldNow;
      assert.deepStrictEqual(yield* Ref.get(sent), ["First."]);
      assert.deepStrictEqual(yield* Ref.get(lifecycle), [
        "authored-1:speech.queued",
        "authored-1:speech.started",
        "authored-2:speech.queued",
      ]);

      const completed = yield* arbiter.observeTranscript({
        session: activeSession,
        itemId: VoiceTranscriptItemId.make("provider-first"),
        text: "Delivered first after the former start deadline.",
        occurredAt: "2026-08-15T00:00:09.000Z",
        outputDone: true,
      });
      assert.strictEqual(completed.completion?.attemptId, "authored-1");
      assert.deepStrictEqual(yield* Ref.get(sent), ["First.", "Second."]);
    }),
  );

  it.effect("suspends the queue and reports recovery when realtime output never terminates", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<Array<string>>([]);
      const lifecycle = yield* Ref.make<Array<string>>([]);
      const firstStarted = yield* Deferred.make<void>();
      const arbiter = yield* makeVoiceSpeechArbiter(
        (speech) =>
          Effect.gen(function* () {
            yield* Ref.update(sent, (all) => [...all, speech.requestedText]);
            if (speech.attemptId !== "authored-1") return;
            yield* Deferred.succeed(firstStarted, undefined);
            return yield* Effect.never;
          }),
        (event) =>
          Ref.update(lifecycle, (all) => [...all, `${event.attempt.attemptId}:${event.kind}`]),
      );
      const activeSession = session();

      const firstEnqueue = yield* arbiter
        .enqueue(attempt(activeSession, "authored-1", "authored", "First."))
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      yield* arbiter.enqueue(attempt(activeSession, "authored-2", "authored", "Second."));

      yield* TestClock.adjust("3 seconds");
      assert.strictEqual(yield* Fiber.join(firstEnqueue), true);
      assert.deepStrictEqual(yield* Ref.get(sent), ["First."]);

      yield* TestClock.adjust("45 seconds");
      yield* Effect.yieldNow;
      assert.strictEqual((yield* arbiter.takeFailure).attemptId, "authored-1");
      assert.deepStrictEqual(yield* Ref.get(sent), ["First."]);
      assert.deepStrictEqual(yield* Ref.get(lifecycle), [
        "authored-1:speech.queued",
        "authored-1:speech.started",
        "authored-2:speech.queued",
        "authored-1:speech.failed",
      ]);
    }),
  );

  it.effect("claims interrupted injected speech without projecting it as delivered", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<Array<string>>([]);
      const arbiter = yield* makeVoiceSpeechArbiter((speech) =>
        Ref.update(sent, (all) => [...all, speech.requestedText]),
      );
      const activeSession = session();

      yield* arbiter.enqueue(attempt(activeSession, "authored-1", "authored", "Long update."));
      yield* arbiter.observeUserSpeech(activeSession);
      const interrupted = yield* arbiter.observeTranscript({
        session: activeSession,
        itemId: VoiceTranscriptItemId.make("provider-interrupted"),
        text: "Long upd—",
        occurredAt: "2026-08-15T00:00:01.000Z",
        outputDone: true,
      });

      assert.strictEqual(interrupted.claimed, true);
      assert.isUndefined(interrupted.completion);
    }),
  );
});
