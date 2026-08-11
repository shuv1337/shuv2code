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

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const ACTIVE_TURN_ID = TurnId.make("turn-active");

function makeReadModel(activeTurnId: TurnId | null = ACTIVE_TURN_ID): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        purpose: "standard",
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn:
          activeTurnId === null
            ? null
            : {
                turnId: activeTurnId,
                state: "running",
                requestedAt: NOW,
                startedAt: NOW,
                completedAt: null,
                assistantMessageId: null,
              },
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
        session: {
          threadId: THREAD_ID,
          status: activeTurnId === null ? "ready" : "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: NOW,
        },
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("thread turn steer decider", (it) => {
  it.effect("emits a message and steer request for the exact active turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.steer",
          commandId: CommandId.make("command-steer"),
          threadId: THREAD_ID,
          expectedTurnId: ACTIVE_TURN_ID,
          message: {
            messageId: MessageId.make("message-steer"),
            role: "user",
            text: "Focus on the failing tests.",
            attachments: [],
          },
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-steer-requested",
      ]);
      const message = events[0];
      const steer = events[1];
      if (
        message?.type !== "thread.message-sent" ||
        steer?.type !== "thread.turn-steer-requested"
      ) {
        throw new Error("Expected message and steer events.");
      }
      expect(message.payload.turnId).toBe(ACTIVE_TURN_ID);
      expect(steer.payload.expectedTurnId).toBe(ACTIVE_TURN_ID);
      expect(steer.payload.clientUserMessageId).toBe("message-steer");
    }),
  );

  it.effect("rejects steering a different active turn", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.steer",
          commandId: CommandId.make("command-steer-stale"),
          threadId: THREAD_ID,
          expectedTurnId: TurnId.make("turn-stale"),
          message: {
            messageId: MessageId.make("message-steer-stale"),
            role: "user",
            text: "Do something else.",
            attachments: [],
          },
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("stale_target");
      }
    }),
  );

  it.effect("rejects steering a terminal thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.steer",
          commandId: CommandId.make("command-steer-terminal"),
          threadId: THREAD_ID,
          expectedTurnId: ACTIVE_TURN_ID,
          message: {
            messageId: MessageId.make("message-steer-terminal"),
            role: "user",
            text: "Continue.",
            attachments: [],
          },
          createdAt: NOW,
        },
        readModel: makeReadModel(null),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("already_terminal");
      }
    }),
  );

  it.effect("enforces the explicit no-active-turn start precondition", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("command-start-stale"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-start-stale"),
            role: "user",
            text: "Start new work.",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          expectedTurnId: null,
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("stale_target");
      }
    }),
  );

  it.effect("accepts an idle start before a fresh thread has a session projection", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel(null);
      const thread = readModel.threads[0];
      if (thread === undefined) throw new Error("Expected test thread.");
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("command-start-fresh"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-start-fresh"),
            role: "user",
            text: "Start the first turn.",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          expectedTurnId: null,
          createdAt: NOW,
        },
        readModel: {
          ...readModel,
          threads: [{ ...thread, session: null }],
        },
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("rejects an explicit idle start while another start is queued", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel(null);
      const thread = readModel.threads[0];
      if (thread === undefined) throw new Error("Expected test thread.");
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("command-start-concurrent"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-start-concurrent"),
            role: "user",
            text: "Start concurrent work.",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          expectedTurnId: null,
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        readModel: {
          ...readModel,
          threads: [
            {
              ...thread,
              latestTurn: null,
              session: null,
              messages: [
                {
                  id: MessageId.make("message-start-queued"),
                  role: "user",
                  text: "Queued work.",
                  turnId: null,
                  streaming: false,
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              ],
            },
          ],
        },
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("queued turn start");
      }
    }),
  );

  it.effect("requires the exact active turn for interruption", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("command-interrupt-stale"),
          threadId: THREAD_ID,
          turnId: TurnId.make("turn-stale"),
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("stale_target");
      }
    }),
  );
});
