import { CommandId, MessageId, TurnId, type VoiceTranscriptItemId } from "@shuv2code/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VoiceCallBridge, type VoiceCallBridgeShape } from "../Services/VoiceCallBridge.ts";
import { voiceError } from "./voiceControllerShared.ts";

interface ProcessedUtterance {
  readonly commandId: CommandId;
  readonly text: string;
}

interface PendingUserTranscript {
  readonly itemId: VoiceTranscriptItemId;
  readonly text: string;
  readonly occurredAt: string;
  readonly activeTranscript: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
  }>;
}

export const deriveVoiceCallTurnIdentity = Effect.fn("VoiceCallBridge.deriveTurnIdentity")(
  function* (input: {
    readonly environmentId: string;
    readonly transportSessionId: string;
    readonly generation: number;
    readonly threadId: string;
    readonly itemId: VoiceTranscriptItemId;
  }) {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          [
            input.environmentId,
            input.transportSessionId,
            input.generation,
            input.threadId,
            input.itemId,
          ].join("\u001f"),
        ),
      )
      .pipe(Effect.map(Encoding.encodeHex), Effect.orDie);
    return {
      commandId: CommandId.make(`voice-call:${digest}:turn-start`),
      messageId: MessageId.make(`voice-call:${digest}:message`),
      exchangeCommandId: CommandId.make(`voice-call:${digest}:exchange-append`),
      assistantMessageId: MessageId.make(`voice-call:${digest}:assistant-message`),
      turnId: TurnId.make(`voice-call:${digest}:turn`),
    } as const;
  },
);

const dispatchError = (error: OrchestrationDispatchError) => {
  if (
    error._tag === "OrchestrationCommandInvariantError" &&
    error.detail.startsWith("stale_target:")
  ) {
    return voiceError(
      "controller_busy",
      "This thread is already working. Wait for it to finish before speaking again.",
      false,
    );
  }
  return voiceError("internal_error", "The spoken turn could not be started.", true);
};

export const makeVoiceCallBridge = Effect.fn("VoiceCallBridge.make")(function* () {
  const crypto = yield* Crypto.Crypto;
  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const utteranceMutex = yield* Semaphore.make(1);
  const processedRef = yield* Ref.make(new Map<string, ProcessedUtterance>());
  const pendingUsersRef = yield* Ref.make(new Map<string, PendingUserTranscript>());

  const ingestTranscript: VoiceCallBridgeShape["ingestTranscript"] = Effect.fn(
    "VoiceCallBridge.ingestTranscript",
  )(function* (input) {
    const owner = input.session.fence.owner;
    if (owner?.kind !== "thread-call") return { accepted: false };
    const text = input.text.trim();
    if (text.length === 0) return { accepted: false };

    return yield* utteranceMutex.withPermits(1)(
      Effect.gen(function* () {
        if (input.role === "user") {
          const key = input.session.transportSessionId;
          const pending = (yield* Ref.get(pendingUsersRef)).get(key);
          if (pending?.itemId === input.itemId && pending.text !== text) {
            return yield* voiceError(
              "protocol_violation",
              "The provider replayed a transcript item with different text.",
              false,
            );
          }
          yield* Ref.update(pendingUsersRef, (all) => {
            const next = new Map(all);
            next.set(key, {
              itemId: input.itemId,
              text,
              occurredAt: input.occurredAt,
              activeTranscript: input.activeTranscript,
            });
            return next;
          });
          return { accepted: true };
        }

        const key = input.session.transportSessionId;
        const pending = (yield* Ref.get(pendingUsersRef)).get(key);
        if (pending === undefined) return { accepted: true };
        const identity = yield* deriveVoiceCallTurnIdentity({
          environmentId: input.session.environmentId,
          transportSessionId: input.session.transportSessionId,
          generation: input.session.fence.generation,
          threadId: owner.threadId,
          itemId: pending.itemId,
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));
        const processed = (yield* Ref.get(processedRef)).get(identity.exchangeCommandId);
        if (processed !== undefined) {
          if (processed.text !== `${pending.text}\u001f${text}`) {
            return yield* voiceError(
              "protocol_violation",
              "The provider replayed a completed voice exchange with different text.",
              false,
            );
          }
          yield* Ref.update(pendingUsersRef, (all) => {
            const next = new Map(all);
            next.delete(key);
            return next;
          });
          return { accepted: true, commandId: processed.commandId };
        }

        const thread = yield* projection
          .getThreadDetailById(owner.threadId)
          .pipe(
            Effect.mapError(() =>
              voiceError("internal_error", "The Call thread could not be read.", true),
            ),
          );
        if (
          Option.isNone(thread) ||
          thread.value.purpose !== "standard" ||
          thread.value.archivedAt !== null ||
          thread.value.deletedAt !== null
        ) {
          return yield* voiceError(
            "controller_not_found",
            "The thread is no longer available for this Call.",
            false,
          );
        }

        yield* engine
          .dispatch(
            {
              type: "thread.voice.exchange.append",
              commandId: identity.exchangeCommandId,
              threadId: owner.threadId,
              turnId: identity.turnId,
              userMessage: { messageId: identity.messageId, text: pending.text },
              assistantMessage: { messageId: identity.assistantMessageId, text },
              createdAt: pending.occurredAt,
              completedAt: input.occurredAt,
            },
            {
              actorProvenance: {
                actorKind: "voice-call",
                environmentId: input.session.environmentId,
                transportSessionId: input.session.transportSessionId,
                generation: input.session.fence.generation,
                transcriptItemId: pending.itemId,
                threadId: owner.threadId,
                activeTranscript: input.activeTranscript.slice(-64),
              },
            },
          )
          .pipe(Effect.mapError(dispatchError));
        yield* Ref.update(pendingUsersRef, (all) => {
          const next = new Map(all);
          next.delete(key);
          return next;
        });
        yield* Ref.update(processedRef, (all) => {
          const next = new Map(all);
          next.set(identity.exchangeCommandId, {
            commandId: identity.exchangeCommandId,
            text: `${pending.text}\u001f${text}`,
          });
          return next;
        });
        return { accepted: true, commandId: identity.exchangeCommandId };
      }),
    );
  });

  const delegateUtterance: VoiceCallBridgeShape["delegateUtterance"] = Effect.fn(
    "VoiceCallBridge.delegateUtterance",
  )(function* (input) {
    const owner = input.session.fence.owner;
    if (owner?.kind !== "thread-call") return { accepted: false };
    const text = input.text.trim();
    if (text.length === 0) return { accepted: false };

    const identity = yield* deriveVoiceCallTurnIdentity({
      environmentId: input.session.environmentId,
      transportSessionId: input.session.transportSessionId,
      generation: input.session.fence.generation,
      threadId: owner.threadId,
      itemId: input.itemId,
    }).pipe(Effect.provideService(Crypto.Crypto, crypto));

    return yield* utteranceMutex.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.update(pendingUsersRef, (all) => {
          const next = new Map(all);
          next.delete(input.session.transportSessionId);
          return next;
        });
        const processed = (yield* Ref.get(processedRef)).get(identity.commandId);
        if (processed !== undefined) {
          if (processed.text !== text) {
            return yield* voiceError(
              "protocol_violation",
              "The provider replayed a transcript item with different text.",
              false,
            );
          }
          return { accepted: true, commandId: processed.commandId };
        }

        const thread = yield* projection
          .getThreadDetailById(owner.threadId)
          .pipe(
            Effect.mapError(() =>
              voiceError("internal_error", "The Call thread could not be read.", true),
            ),
          );
        if (
          Option.isNone(thread) ||
          thread.value.purpose !== "standard" ||
          thread.value.archivedAt !== null ||
          thread.value.deletedAt !== null
        ) {
          return yield* voiceError(
            "controller_not_found",
            "The thread is no longer available for this Call.",
            false,
          );
        }
        yield* engine
          .dispatch(
            thread.value.latestTurn?.state === "running"
              ? {
                  type: "thread.turn.steer",
                  commandId: identity.commandId,
                  threadId: owner.threadId,
                  expectedTurnId: thread.value.latestTurn.turnId,
                  message: {
                    messageId: identity.messageId,
                    role: "user",
                    text,
                    attachments: [],
                  },
                  createdAt: input.occurredAt,
                }
              : {
                  type: "thread.turn.start",
                  commandId: identity.commandId,
                  threadId: owner.threadId,
                  message: {
                    messageId: identity.messageId,
                    role: "user",
                    text,
                    attachments: [],
                  },
                  modelSelection: thread.value.modelSelection,
                  runtimeMode: thread.value.runtimeMode,
                  interactionMode: thread.value.interactionMode,
                  expectedTurnId: null,
                  createdAt: input.occurredAt,
                },
            {
              actorProvenance: {
                actorKind: "voice-call",
                environmentId: input.session.environmentId,
                transportSessionId: input.session.transportSessionId,
                generation: input.session.fence.generation,
                transcriptItemId: input.itemId,
                threadId: owner.threadId,
                activeTranscript: input.activeTranscript.slice(-64).map((entry) => ({
                  role: entry.role,
                  text: entry.text.slice(0, 16_384),
                })),
              },
            },
          )
          .pipe(Effect.mapError(dispatchError));
        yield* Ref.update(processedRef, (processed) => {
          const next = new Map(processed);
          next.set(identity.commandId, { commandId: identity.commandId, text });
          return next;
        });
        return { accepted: true, commandId: identity.commandId };
      }),
    );
  });

  return VoiceCallBridge.of({ ingestTranscript, delegateUtterance });
});

export const VoiceCallBridgeLive = Layer.effect(VoiceCallBridge, makeVoiceCallBridge());
