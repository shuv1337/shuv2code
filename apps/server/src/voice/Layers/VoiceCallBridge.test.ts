import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  VoiceClientSessionId,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
  VoiceTranscriptItemId,
  type OrchestrationCommand,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { type ActiveVoiceSession } from "../Services/VoiceTransportCoordinator.ts";
import { VoiceCallBridge } from "../Services/VoiceCallBridge.ts";
import { VoiceCallBridgeLive, deriveVoiceCallTurnIdentity } from "./VoiceCallBridge.ts";

const threadId = ThreadId.make("thread-call-owner");
const now = "2026-08-14T00:00:00.000Z";

const thread = {
  id: threadId,
  projectId: "project-1",
  purpose: "standard",
  title: "Called thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("provider-1"),
    model: "gpt-test",
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
} as const;

const callSession = {
  transportSessionId: "client-1:1",
  fence: {
    environmentId: EnvironmentId.make("environment-1"),
    owner: { kind: "thread-call", threadId } as const,
    controllerThreadId: threadId,
    transportThreadId: ThreadId.make("voice-transport-1"),
    clientSessionId: VoiceClientSessionId.make("client-1"),
    generation: VoiceGeneration.make(1),
    runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-1"),
    realtimeSessionId: VoiceRealtimeSessionId.make("realtime-1"),
  },
  environmentId: EnvironmentId.make("environment-1"),
  hostProjectId: thread.projectId,
  transportProviderInstanceId: ProviderInstanceId.make("codex-voice"),
  controller: null,
  controllerRuntime: null,
  transportType: "webrtc",
  purpose: "conversation",
  answerSdp: "answer",
  lastAudioSequence: 0,
  eventCursor: 0,
  history: [],
} as unknown as ActiveVoiceSession;

const makeTestLayer = Effect.gen(function* () {
  const commands = yield* Ref.make<Array<OrchestrationCommand>>([]);
  const dispatchOptions = yield* Ref.make<Array<unknown>>([]);
  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    dispatch: (command, options) =>
      Ref.update(commands, (all) => [...all, command]).pipe(
        Effect.andThen(Ref.update(dispatchOptions, (all) => [...all, options])),
        Effect.as({ sequence: 1 }),
      ) as never,
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    latestSequence: Effect.succeed(0),
  });
  const projection = ProjectionSnapshotQuery.of({
    getThreadDetailById: (id: ThreadId) =>
      Effect.succeed(id === threadId ? Option.some(thread) : Option.none()),
  } as never);
  return {
    commands,
    dispatchOptions,
    layer: VoiceCallBridgeLive.pipe(
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, projection)),
      Layer.provide(NodeServices.layer),
    ),
  };
});

describe("VoiceCallBridge", () => {
  it.effect("derives stable command and message identities from the fenced utterance", () =>
    Effect.gen(function* () {
      const input = {
        environmentId: "environment-1",
        transportSessionId: "client-1:1",
        generation: 1,
        threadId,
        itemId: VoiceTranscriptItemId.make("item-1"),
      };
      const first = yield* deriveVoiceCallTurnIdentity(input);
      const replay = yield* deriveVoiceCallTurnIdentity(input);
      assert.deepStrictEqual(first, replay);
      assert.notStrictEqual(String(first.commandId), String(first.messageId));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records a completed realtime exchange without starting the ordinary model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeTestLayer;
        const bridge = yield* VoiceCallBridge.pipe(Effect.provide(test.layer));
        const user = yield* bridge.ingestTranscript({
          session: callSession,
          itemId: VoiceTranscriptItemId.make("user-item-1"),
          role: "user",
          text: "How is the investigation going?",
          occurredAt: now,
          activeTranscript: [],
        });
        assert.isTrue(user.accepted);
        assert.isEmpty(yield* Ref.get(test.commands));

        const assistant = yield* bridge.ingestTranscript({
          session: callSession,
          itemId: VoiceTranscriptItemId.make("assistant-item-1"),
          role: "assistant",
          text: "It is moving along well.",
          occurredAt: "2026-08-14T00:00:02.000Z",
          activeTranscript: [
            { role: "user", text: "How is the investigation going?" },
            { role: "assistant", text: "It is moving along well." },
          ],
        });
        assert.isTrue(assistant.accepted);

        const commands = yield* Ref.get(test.commands);
        assert.strictEqual(commands.length, 1);
        const command = commands[0];
        assert.isDefined(command);
        assert.strictEqual(command.type, "thread.voice.exchange.append");
        if (command.type !== "thread.voice.exchange.append") return;
        assert.strictEqual(command.threadId, threadId);
        assert.strictEqual(command.userMessage.text, "How is the investigation going?");
        assert.strictEqual(command.assistantMessage.text, "It is moving along well.");
        assert.notStrictEqual(command.userMessage.messageId, command.assistantMessage.messageId);
        assert.isFalse(commands.some((entry) => entry.type === "thread.turn.start"));
      }),
    ),
  );

  it.effect("dispatches one ordinary turn to the exact owner for duplicate handoffs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeTestLayer;
        const bridge = yield* VoiceCallBridge.pipe(Effect.provide(test.layer));
        const utterance = {
          session: callSession,
          itemId: VoiceTranscriptItemId.make("item-1"),
          text: "  Check the exact thread.  ",
          occurredAt: now,
          activeTranscript: [
            { role: "user" as const, text: "Check the exact thread." },
            { role: "assistant" as const, text: "I'll take that into the thread." },
          ],
        };
        const first = yield* bridge.delegateUtterance(utterance);
        const replay = yield* bridge.delegateUtterance(utterance);
        assert.isTrue(first.accepted);
        assert.strictEqual(replay.commandId, first.commandId);

        const commands = yield* Ref.get(test.commands);
        assert.strictEqual(commands.length, 1);
        const command = commands[0];
        assert.isDefined(command);
        assert.strictEqual(command.type, "thread.turn.start");
        if (command.type !== "thread.turn.start") return;
        assert.isDefined(first.commandId);
        assert.deepStrictEqual(command, {
          type: "thread.turn.start",
          commandId: first.commandId,
          threadId,
          message: {
            messageId: command.message.messageId,
            role: "user",
            text: "Check the exact thread.",
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          expectedTurnId: null,
          createdAt: command.createdAt,
        });
        const receipts = test.dispatchOptions;
        assert.deepStrictEqual(yield* Ref.get(receipts), [
          {
            actorProvenance: {
              actorKind: "voice-call",
              environmentId: callSession.environmentId,
              transportSessionId: callSession.transportSessionId,
              generation: callSession.fence.generation,
              transcriptItemId: utterance.itemId,
              threadId,
              callIdentity: {
                threadId,
                threadTitle: thread.title,
                projectId: thread.projectId,
                durableProviderInstanceId: thread.modelSelection.instanceId,
                durableModel: thread.modelSelection.model,
                durableAgent: null,
                transportProviderInstanceId: callSession.transportProviderInstanceId,
                transportModel: "unknown-realtime-model",
              },
              activeTranscript: utterance.activeTranscript,
            },
          },
        ]);
      }),
    ),
  );

  it.effect("preserves the finalized user transcript when a handoff condenses it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeTestLayer;
        const bridge = yield* VoiceCallBridge.pipe(Effect.provide(test.layer));
        const finalizedText =
          "Keep my complete spoken request in the durable thread, including this detail.";
        yield* bridge.ingestTranscript({
          session: callSession,
          itemId: VoiceTranscriptItemId.make("user-transcript-1"),
          role: "user",
          text: finalizedText,
          occurredAt: now,
          activeTranscript: [{ role: "user", text: finalizedText }],
        });

        yield* bridge.delegateUtterance({
          session: callSession,
          itemId: VoiceTranscriptItemId.make("handoff-item-1"),
          text: "Handle the request.",
          occurredAt: "2026-08-14T00:00:02.000Z",
          activeTranscript: [
            { role: "user", text: finalizedText },
            { role: "assistant", text: "I’ll take that into the thread." },
          ],
        });

        const commands = yield* Ref.get(test.commands);
        assert.strictEqual(commands.length, 1);
        const command = commands[0];
        assert.isDefined(command);
        assert.strictEqual(command.type, "thread.turn.start");
        if (command.type !== "thread.turn.start") return;
        assert.strictEqual(command.message.text, finalizedText);
        assert.strictEqual(command.createdAt, now);
      }),
    ),
  );

  it.effect("uses the latest active user transcript when handoff arrives before finalization", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeTestLayer;
        const bridge = yield* VoiceCallBridge.pipe(Effect.provide(test.layer));
        const finalizedText = "This is the complete user utterance from active transcript.";

        yield* bridge.delegateUtterance({
          session: callSession,
          itemId: VoiceTranscriptItemId.make("handoff-item-2"),
          text: "Condensed instruction.",
          occurredAt: now,
          activeTranscript: [
            { role: "user", text: "An older request." },
            { role: "assistant", text: "That one is done." },
            { role: "user", text: finalizedText },
            { role: "assistant", text: "I’ll delegate it." },
          ],
        });

        const commands = yield* Ref.get(test.commands);
        assert.strictEqual(commands.length, 1);
        const command = commands[0];
        assert.isDefined(command);
        assert.strictEqual(command.type, "thread.turn.start");
        if (command.type !== "thread.turn.start") return;
        assert.strictEqual(command.message.text, finalizedText);
      }),
    ),
  );

  it.effect("does not route Controller transcripts through the Call bridge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeTestLayer;
        const bridge = yield* VoiceCallBridge.pipe(Effect.provide(test.layer));
        const result = yield* bridge.delegateUtterance({
          session: {
            ...callSession,
            fence: {
              ...callSession.fence,
              owner: { kind: "controller", controllerThreadId: threadId },
            },
          },
          itemId: VoiceTranscriptItemId.make("item-controller"),
          text: "Controller input",
          occurredAt: now,
          activeTranscript: [],
        });
        assert.isFalse(result.accepted);
        assert.isEmpty(yield* Ref.get(test.commands));
      }),
    ),
  );

  it.effect("rejects a conflicting replay of the same provider item", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeTestLayer;
        const bridge = yield* VoiceCallBridge.pipe(Effect.provide(test.layer));
        const itemId = VoiceTranscriptItemId.make("item-conflict");
        yield* bridge.delegateUtterance({
          session: callSession,
          itemId,
          text: "First",
          occurredAt: now,
          activeTranscript: [],
        });
        const error = yield* bridge
          .delegateUtterance({
            session: callSession,
            itemId,
            text: "Changed",
            occurredAt: now,
            activeTranscript: [],
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "protocol_violation");
        assert.strictEqual((yield* Ref.get(test.commands)).length, 1);
      }),
    ),
  );
});
