import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@shuv2code/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-14T02:00:00.000Z";
const COMPLETED_AT = "2026-08-14T02:00:03.000Z";
const THREAD_ID = ThreadId.make("thread-voice-exchange");

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project-voice-exchange"),
      purpose: "standard",
      title: "Voice exchange",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-luna",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: NOW,
};

it.layer(NodeServices.layer)("realtime voice exchange decider", (it) => {
  it.effect("emits one completed exchange event without requesting a provider turn", () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-voice-exchange");
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.voice.exchange.append",
          commandId: CommandId.make("command-voice-exchange"),
          threadId: THREAD_ID,
          turnId,
          userMessage: {
            messageId: MessageId.make("message-voice-user"),
            text: "Can you explain that?",
          },
          assistantMessage: {
            messageId: MessageId.make("message-voice-assistant"),
            text: "Yes. Realtime remains in the lead.",
          },
          createdAt: NOW,
          completedAt: COMPLETED_AT,
        },
        readModel,
      });

      expect(Array.isArray(result)).toBe(false);
      if (Array.isArray(result)) {
        throw new Error("Expected one realtime voice exchange event.");
      }
      const event = result as Exclude<typeof result, ReadonlyArray<unknown>>;
      expect(event.type).toBe("thread.voice-exchange-appended");
      expect(event.payload).toEqual({
        threadId: THREAD_ID,
        turnId,
        userMessage: {
          messageId: "message-voice-user",
          text: "Can you explain that?",
        },
        assistantMessage: {
          messageId: "message-voice-assistant",
          text: "Yes. Realtime remains in the lead.",
        },
        createdAt: NOW,
        completedAt: COMPLETED_AT,
      });
    }),
  );

  it.effect("emits exact delegated speech without changing provider turn lifecycle", () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-provider-owned");
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.voice.speech.append",
          commandId: CommandId.make("command-voice-speech"),
          threadId: THREAD_ID,
          turnId,
          messageId: MessageId.make("message-voice-speech"),
          text: "The checks passed. I left the detailed results in the thread.",
          createdAt: NOW,
        },
        readModel,
      });

      expect(Array.isArray(result)).toBe(false);
      if (Array.isArray(result)) {
        throw new Error("Expected one voice speech event.");
      }
      const event = result as Exclude<typeof result, ReadonlyArray<unknown>>;
      expect(event.type).toBe("thread.voice-speech-appended");
      expect(event.payload).toEqual({
        threadId: THREAD_ID,
        turnId,
        messageId: "message-voice-speech",
        text: "The checks passed. I left the detailed results in the thread.",
        createdAt: NOW,
      });
    }),
  );
});
