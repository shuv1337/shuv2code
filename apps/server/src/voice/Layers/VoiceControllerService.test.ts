import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ThreadId,
  VoiceActionId,
  VoiceClientSessionId,
  VoiceGeneration,
  VoiceRuntimeInstanceId,
  type VoiceSessionEvent,
} from "@shuv2code/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  appendVoiceSessionEvent,
  claimVoiceTargetPhase,
  confirmedControllerModelSelection,
  controllerHistoryDisplayText,
  controllerHistoryMessages,
  controllerTranscriptWithActiveTarget,
  controllerActionStartRequest,
  deriveVoiceActionId,
  planVoicePolicyTransition,
  publicVoiceSessionId,
  runSerializedVoiceActions,
  targetThreadIdFromVoiceMutation,
  targetPhaseOf,
  voiceTargetStatusText,
} from "./VoiceControllerService.ts";

describe("VoiceControllerService coordination invariants", () => {
  it.effect(
    "deduplicates a handoff tuple and binds the exact action id to one no-recovery turn",
    () =>
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
        const distinct = yield* deriveVoiceActionId({ ...identity, itemId: "item-2" });
        assert.strictEqual(first, replay);
        assert.notStrictEqual(first, distinct);

        const request = controllerActionStartRequest({
          controllerThreadId: ThreadId.make("controller"),
          controllerRuntimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
          voiceActionId: first,
          transcript: "Create the investigation thread.",
        });
        assert.strictEqual(request.clientUserMessageId, first);
        assert.strictEqual(request.recoveryPolicy, "forbid");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("processes queued controller actions serially", () =>
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

  it("keeps the public event cursor keyed by client session rather than the durable lease id", () => {
    const clientSessionId = "browser-client" as never;
    assert.strictEqual(
      publicVoiceSessionId({
        fence: { clientSessionId },
      }),
      clientSessionId,
    );
    assert.notStrictEqual(clientSessionId, `${clientSessionId}:1`);
  });

  it.effect("allocates and publishes event sequences atomically under concurrent emitters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const clientSessionId = VoiceClientSessionId.make("atomic-events");
        const runtimeInstanceId = VoiceRuntimeInstanceId.make("runtime-atomic-events");
        const sessionsRef = yield* Ref.make(
          new Map<
            string,
            {
              fence: {
                clientSessionId: VoiceClientSessionId;
                generation: VoiceGeneration;
                runtimeInstanceId: VoiceRuntimeInstanceId;
              };
              eventCursor: number;
              history: ReadonlyArray<VoiceSessionEvent>;
            }
          >([
            [
              clientSessionId,
              {
                fence: {
                  clientSessionId,
                  generation: VoiceGeneration.make(1),
                  runtimeInstanceId,
                },
                eventCursor: 0,
                history: [],
              },
            ],
          ]),
        );
        const events = yield* PubSub.unbounded<VoiceSessionEvent>();
        const mutex = yield* Semaphore.make(1);
        const subscription = yield* mutex.withPermits(1)(
          Effect.gen(function* () {
            const latest = (yield* Ref.get(sessionsRef)).get(clientSessionId);
            const changes = yield* PubSub.subscribe(events);
            return { latest, changes };
          }),
        );
        const liveFiber = yield* Stream.fromSubscription(subscription.changes).pipe(
          Stream.take(64),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.forEach(
          Array.from({ length: 64 }, (_, index) => index),
          () =>
            appendVoiceSessionEvent({
              sessionsRef,
              events,
              mutex,
              sessionId: clientSessionId,
              occurredAt: "2026-07-30T00:00:00.000Z",
              payload: {
                type: "session.error",
                code: "internal_error",
                retryable: true,
              },
            }),
          { concurrency: "unbounded", discard: true },
        );
        const published = Array.from(yield* Fiber.join(liveFiber));
        const final = (yield* Ref.get(sessionsRef)).get(clientSessionId);
        assert.deepStrictEqual(
          published.map((event) => event!.sequence),
          Array.from({ length: 64 }, (_, index) => index + 1),
        );
        assert.deepStrictEqual(
          final?.history.map((event) => event.sequence),
          Array.from({ length: 64 }, (_, index) => index + 1),
        );
        assert.strictEqual(final?.eventCursor, 64);
      }),
    ),
  );

  it.effect("closes the history-to-live gap when subscription races one emit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const clientSessionId = VoiceClientSessionId.make("subscription-race");
        const runtimeInstanceId = VoiceRuntimeInstanceId.make("runtime-subscription-race");
        const sessionsRef = yield* Ref.make(
          new Map<
            string,
            {
              fence: {
                clientSessionId: VoiceClientSessionId;
                generation: VoiceGeneration;
                runtimeInstanceId: VoiceRuntimeInstanceId;
              };
              eventCursor: number;
              history: ReadonlyArray<VoiceSessionEvent>;
            }
          >([
            [
              clientSessionId,
              {
                fence: {
                  clientSessionId,
                  generation: VoiceGeneration.make(1),
                  runtimeInstanceId,
                },
                eventCursor: 0,
                history: [],
              },
            ],
          ]),
        );
        const events = yield* PubSub.unbounded<VoiceSessionEvent>();
        const mutex = yield* Semaphore.make(1);
        const [subscription] = yield* Effect.all(
          [
            mutex.withPermits(1)(
              Effect.gen(function* () {
                const latest = (yield* Ref.get(sessionsRef)).get(clientSessionId);
                const changes = yield* PubSub.subscribe(events);
                return { latest, changes };
              }),
            ),
            appendVoiceSessionEvent({
              sessionsRef,
              events,
              mutex,
              sessionId: clientSessionId,
              occurredAt: "2026-07-30T00:00:00.000Z",
              payload: {
                type: "session.error",
                code: "internal_error",
                retryable: true,
              },
            }),
          ] as const,
          { concurrency: "unbounded" },
        );
        const replay = subscription.latest?.history ?? [];
        const delivered =
          replay.length > 0
            ? replay
            : Array.from(
                yield* Stream.fromSubscription(subscription.changes).pipe(
                  Stream.take(1),
                  Stream.runCollect,
                  Effect.timeout("1 second"),
                ),
              );
        assert.strictEqual(delivered.length, 1);
        assert.strictEqual(delivered[0]?.sequence, 1);
      }),
    ),
  );

  it("rotates grants on live read/control changes and increments the epoch only on disable", () => {
    assert.deepStrictEqual(
      planVoicePolicyTransition({ read: true, control: true }, { read: true, control: false }),
      {
        incrementControlEpoch: true,
        rotateControllerRuntime: true,
        restartControllerRuntime: true,
      },
    );
    assert.deepStrictEqual(
      planVoicePolicyTransition({ read: true, control: false }, { read: true, control: false }),
      {
        incrementControlEpoch: false,
        rotateControllerRuntime: false,
        restartControllerRuntime: false,
      },
    );
    assert.deepStrictEqual(
      planVoicePolicyTransition({ read: true, control: false }, { read: false, control: false }),
      {
        incrementControlEpoch: false,
        rotateControllerRuntime: true,
        restartControllerRuntime: false,
      },
    );
  });

  it("uses the confirmed controller runtime model for transport provisioning", () => {
    const confirmed = { instanceId: "codex" as never, model: "gpt-5.5" };
    const staleProjection = { instanceId: "codex" as never, model: "gpt-5.4" };
    assert.deepStrictEqual(
      confirmedControllerModelSelection({ modelSelection: confirmed }),
      confirmed,
    );
    assert.notStrictEqual(
      confirmedControllerModelSelection({ modelSelection: confirmed }).model,
      staleProjection.model,
    );
  });

  it.effect("reseeds target identities and coalesces duplicate target phases", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        targetThreadIdFromVoiceMutation({
          voiceActionId: "action-create",
          toolName: "thread_create",
          semanticSlot: "create:project",
        }),
        "voice:action-create:thread",
      );
      assert.strictEqual(
        targetThreadIdFromVoiceMutation({
          voiceActionId: "action-send",
          toolName: "thread_send",
          semanticSlot: "send:target-thread",
        }),
        "target-thread",
      );
      assert.strictEqual(
        targetThreadIdFromVoiceMutation({
          voiceActionId: "action-interrupt",
          toolName: "thread_interrupt",
          semanticSlot: "interrupt:target-thread:turn-1",
        }),
        "target-thread",
      );
      const phases = yield* Ref.make(new Map());
      const watch = {
        voiceActionId: VoiceActionId.make("action-send"),
        transportSessionId: "transport-1",
        targetThreadId: ThreadId.make("target-thread"),
      };
      assert.strictEqual(yield* claimVoiceTargetPhase(phases, watch, "working"), true);
      assert.strictEqual(yield* claimVoiceTargetPhase(phases, watch, "working"), false);
      assert.strictEqual(yield* claimVoiceTargetPhase(phases, watch, "waiting_for_input"), true);
      assert.strictEqual(
        yield* claimVoiceTargetPhase(
          phases,
          { ...watch, transportSessionId: "transport-2" },
          "waiting_for_input",
        ),
        true,
      );
    }),
  );

  it("builds bounded watcher context for the realtime conversation", () => {
    assert.strictEqual(
      voiceTargetStatusText({
        projectTitle: "shuv2code",
        threadTitle: "Fix voice progress",
        phase: "waiting_for_approval",
      }),
      'Voice target "Fix voice progress" in "shuv2code" is waiting for approval.',
    );
    assert.isAtMost(
      voiceTargetStatusText({
        projectTitle: "p".repeat(1_000),
        threadTitle: "t".repeat(1_000),
        phase: "completed",
      }).length,
      512,
    );
  });

  it("lets terminal and authoritative pending-start state suppress stale wait rows", () => {
    const phase = (input: {
      readonly sessionStatus: string | null;
      readonly latestState: string | null;
      readonly approval?: boolean;
      readonly userInput?: boolean;
    }) =>
      targetPhaseOf({
        hasPendingApprovals: input.approval ?? false,
        hasPendingUserInput: input.userInput ?? false,
        session: input.sessionStatus === null ? null : { status: input.sessionStatus },
        latestTurn: input.latestState === null ? null : { state: input.latestState },
      } as never);

    assert.strictEqual(
      phase({ sessionStatus: "error", latestState: "running", approval: true }),
      "failed",
    );
    assert.strictEqual(
      phase({ sessionStatus: "stopped", latestState: null, userInput: true }),
      "stopped",
    );
    assert.strictEqual(
      phase({ sessionStatus: "ready", latestState: "completed", approval: true }),
      "completed",
    );
    assert.strictEqual(
      phase({ sessionStatus: "starting", latestState: "completed", approval: true }),
      "starting",
    );
    assert.strictEqual(
      phase({ sessionStatus: "running", latestState: "running", approval: true }),
      "waiting_for_approval",
    );
  });

  it("rehydrates an exact active target with an explicit context-read instruction", () => {
    assert.strictEqual(
      controllerTranscriptWithActiveTarget("What is its status?", null),
      "What is its status?",
    );
    const transcript = controllerTranscriptWithActiveTarget(
      "What is its status?",
      ThreadId.make("target-thread-1"),
    );
    assert.include(transcript, 'activeTargetThreadId="target-thread-1"');
    assert.include(transcript, "includeUntrustedContext=true");
    assert.include(transcript, "What is its status?");
  });

  it("normalizes provider history into user requests and final controller replies", () => {
    const turnId = "turn-history-1" as never;
    const messages = controllerHistoryMessages({
      threadId: ThreadId.make("voice-controller:history"),
      turns: [
        {
          id: turnId,
          status: "completed",
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [
                {
                  type: "text",
                  text: [
                    "Bounded controller state (resolution hint only; server authorization still applies):",
                    'activeTargetThreadId="target-thread-1"',
                    "",
                    "User request:",
                    "What is its status?",
                  ].join("\n"),
                },
                { type: "localAudio", path: "/tmp/voice.wav" },
              ],
            },
            {
              id: "assistant-commentary",
              type: "agentMessage",
              phase: "commentary",
              text: "I am checking the target.",
            },
            {
              id: "assistant-final",
              type: "agentMessage",
              phase: "final_answer",
              text: "It is waiting for approval.",
            },
          ],
        },
      ],
    });

    assert.deepStrictEqual(
      messages.map(({ role, text }) => ({ role, text })),
      [
        { role: "user", text: "What is its status?" },
        { role: "assistant", text: "It is waiting for approval." },
      ],
    );
    assert.strictEqual(
      controllerHistoryDisplayText("A request without controller context."),
      "A request without controller context.",
    );
  });
});
