import {
  CommandId,
  ThreadId,
  VOICE_PCM_DEFAULT_CHANNELS,
  VOICE_PCM_DEFAULT_SAMPLE_RATE_HZ,
  VoiceEventSequence,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
  VoiceTranscriptionRequestId,
  resolveVoiceSessionStartTransport,
  type VoiceSessionEvent,
  type VoiceSessionFence,
} from "@shuv2code/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { VoiceControllerActionRepository } from "../../persistence/Services/VoiceControllerActions.ts";
import { VoiceTransportSessionRepository } from "../../persistence/Services/VoiceTransportSessions.ts";
import type { VoiceTransportSession } from "../../persistence/VoiceControlModels.ts";
import {
  VoiceTransportCoordinator,
  type ActiveVoiceSession,
  type ControllerRuntimeState,
  type VoiceTransportCoordinatorShape,
} from "../Services/VoiceTransportCoordinator.ts";
import { VoiceRuntimeGateway } from "../Services/VoiceRuntimeGateway.ts";
import { VoiceSpeechArbiter } from "../Services/VoiceSpeechArbiter.ts";
import {
  decideProactiveSpeech,
  rememberProactiveSpeech,
  type ProactiveSpeechMemoryEntry,
} from "../VoiceProactiveSpeechPolicy.ts";
import { runVoiceTransportFeedback } from "../VoiceTransportFeedback.ts";
import {
  appendVoiceSessionEvent,
  confirmedControllerModelSelection,
  controllerIdentity,
  fenceMatches,
  mapInternalError,
  publicVoiceSessionId,
  voiceSessionOwnersEqual,
  voiceError,
} from "./voiceControllerShared.ts";

const CALL_CONTEXT_MAX_ITEMS = 24;
const CALL_CONTEXT_MAX_CHARS = 24_000;
export const CALL_REALTIME_PROMPT = [
  "You are the primary realtime conversational voice for an active call attached to one exact coding thread.",
  "Stay in the conversation and answer the user aloud yourself whenever the request can be answered from the supplied thread context or ordinary conversation. The supplied thread messages are real context; questions about them do not require a handoff.",
  "Do not delegate merely to verify, restate, summarize, or discuss the supplied context. Fast spoken response is the priority.",
  "Treat a short, incomplete, or trailing utterance as live conversation, not durable work. Ask one brief spoken clarification or allow the user to continue; do not hand off a fragment merely because its intent is unclear.",
  "Create a handoff only when the request genuinely requires tools, repository inspection, code changes, approvals, or a durable detailed artifact that you cannot produce from the supplied context.",
  "A handoff extends this same live call; it does not replace or end it. Before handing off, say one short, complete, context-specific sentence that acknowledges the user's request and names the next step. Never use a bare status filler such as 'Checking', 'Hang on', 'One moment', or 'Let me check'. Do not invent work results.",
  "The backing thread owns durable work while you own the low-latency conversation. Avoid repeating text already present in the call transcript.",
].join("\n");

export function boundedCallInitialItems(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly streaming: boolean;
  }>,
): ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }> {
  const selected: Array<{ readonly role: "user" | "assistant"; readonly text: string }> = [];
  let remaining = CALL_CONTEXT_MAX_CHARS;
  for (const message of messages.slice().toReversed()) {
    if (
      selected.length >= CALL_CONTEXT_MAX_ITEMS ||
      remaining <= 0 ||
      message.streaming ||
      message.role === "system"
    ) {
      continue;
    }
    const text = message.text.trim().slice(-remaining);
    if (text.length === 0) continue;
    selected.push({ role: message.role, text });
    remaining -= text.length;
  }
  return selected.toReversed();
}

export const makeVoiceTransportCoordinator = Effect.fn("VoiceTransportCoordinator.make")(
  function* () {
    const crypto = yield* Crypto.Crypto;
    const environment = yield* ServerEnvironment;
    const engine = yield* OrchestrationEngineService;
    const transports = yield* VoiceTransportSessionRepository;
    const actions = yield* VoiceControllerActionRepository;
    const runtime = yield* VoiceRuntimeGateway;
    const speechArbiter = yield* VoiceSpeechArbiter;
    const events = yield* PubSub.unbounded<VoiceSessionEvent>();
    const eventMutex = yield* Semaphore.make(1);
    const sessionsRef = yield* Ref.make(new Map<string, ActiveVoiceSession>());
    const controllerRuntimesRef = yield* Ref.make(new Map<ThreadId, ControllerRuntimeState>());
    const speechMemoryRef = yield* Ref.make(new Map<string, ProactiveSpeechMemoryEntry>());
    const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);

    const emit: VoiceTransportCoordinatorShape["emit"] = Effect.fn(
      "VoiceTransportCoordinator.emit",
    )(function* (sessionId, payload) {
      return yield* appendVoiceSessionEvent({
        sessionsRef,
        events,
        mutex: eventMutex,
        sessionId,
        occurredAt: DateTime.formatIso(yield* DateTime.now),
        payload,
      });
    });

    const archiveTransportThread = (session: VoiceTransportSession) =>
      engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(
            `voice-transport:archive:${session.transportSessionId}:${session.generation}`,
          ),
          threadId: session.transportThreadId,
        })
        .pipe(Effect.ignore);

    const cleanupDurableTransportLease = Effect.fn(
      "VoiceTransportCoordinator.cleanupDurableTransportLease",
    )(function* (session: VoiceTransportSession) {
      const closedAt = DateTime.formatIso(yield* DateTime.now);
      yield* runtime
        .stopTransport({
          transportThreadId: session.transportThreadId,
          runtimeInstanceId: VoiceRuntimeInstanceId.make(session.runtimeInstanceId),
          generation: VoiceGeneration.make(session.generation),
          ...(session.realtimeSessionId === null
            ? {}
            : { realtimeSessionId: VoiceRealtimeSessionId.make(session.realtimeSessionId) }),
        })
        .pipe(Effect.ignore);
      yield* actions
        .fenceTransportGeneration({
          transportSessionId: session.transportSessionId,
          throughGeneration: session.generation,
          closedAt,
        })
        .pipe(Effect.ignore);
      yield* transports
        .fenceGeneration({
          environmentId: session.environmentId,
          throughGeneration: session.generation,
          fencedAt: closedAt,
        })
        .pipe(Effect.ignore);
      yield* archiveTransportThread(session);
    });

    // In-memory WebRTC state is process-local. Any durable lease left open when
    // this service is constructed belongs to a previous process generation and
    // must be fenced before it can block the next client generation.
    const cleanupStaleStartupLease: VoiceTransportCoordinatorShape["cleanupStaleStartupLease"] =
      Effect.fn("VoiceTransportCoordinator.cleanupStaleStartupLease")(function* (environmentId) {
        const staleStartupLease = yield* transports
          .getOpenByEnvironmentId(environmentId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(staleStartupLease)) {
          yield* cleanupDurableTransportLease(staleStartupLease.value);
        }
      });

    const startupEnvironmentId = yield* environment.getEnvironmentId;
    yield* cleanupStaleStartupLease(startupEnvironmentId);

    const stopSession: VoiceTransportCoordinatorShape["stopSession"] = Effect.fn(
      "VoiceTransportCoordinator.stopSession",
    )(function* (session) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* transports
        .compareAndSetState({
          transportSessionId: session.transportSessionId,
          generation: session.fence.generation,
          runtimeInstanceId: session.fence.runtimeInstanceId,
          expectedState: "active",
          nextState: "closing",
          updatedAt: now,
          closedAt: null,
        })
        .pipe(Effect.ignore);
      yield* runtime
        .stopTransport({
          transportThreadId: session.fence.transportThreadId,
          runtimeInstanceId: session.fence.runtimeInstanceId,
          generation: session.fence.generation,
          realtimeSessionId: session.fence.realtimeSessionId,
        })
        .pipe(Effect.ignore);
      yield* actions
        .fenceTransportGeneration({
          transportSessionId: session.transportSessionId,
          throughGeneration: session.fence.generation,
          closedAt: now,
        })
        .pipe(Effect.ignore);
      yield* transports
        .compareAndSetState({
          transportSessionId: session.transportSessionId,
          generation: session.fence.generation,
          runtimeInstanceId: session.fence.runtimeInstanceId,
          expectedState: "closing",
          nextState: "closed",
          updatedAt: now,
          closedAt: now,
        })
        .pipe(Effect.ignore);
      // Voice transport threads are runtime plumbing, not user conversations.
      // Archive the projection as part of every normal stop so a completed
      // call cannot leak a ghost row into thread surfaces.
      yield* archiveTransportThread({
        transportSessionId: session.transportSessionId,
        environmentId: session.environmentId,
        ownerKind:
          session.fence.owner?.kind === "thread-call"
            ? "thread-call"
            : session.fence.owner?.kind === "transcription-test"
              ? "transcription-test"
              : "controller",
        ownerId:
          session.fence.owner?.kind === "thread-call"
            ? session.fence.owner.threadId
            : session.fence.owner?.kind === "transcription-test"
              ? session.fence.owner.requestId
              : session.fence.controllerThreadId,
        anchorThreadId:
          session.fence.owner?.kind === "transcription-test"
            ? session.fence.owner.providerAnchorThreadId
            : null,
        controllerThreadId: session.fence.controllerThreadId,
        transportThreadId: session.fence.transportThreadId,
        runtimeInstanceId: session.fence.runtimeInstanceId,
        generation: session.fence.generation,
        realtimeSessionId: session.fence.realtimeSessionId,
        state: "closed",
        createdAt: now,
        updatedAt: now,
        closedAt: now,
      });
      yield* emit(session.fence.clientSessionId, {
        type: "session.state",
        state: "stopped",
      });
      yield* Ref.update(sessionsRef, (sessions) => {
        const next = new Map(sessions);
        next.delete(session.fence.clientSessionId);
        return next;
      });
    });

    const startTransport: VoiceTransportCoordinatorShape["startTransport"] = Effect.fn(
      "VoiceTransportCoordinator.startTransport",
    )(function* (input) {
      const { start: startInput, binding, controllerRuntime, environmentId, workspaceRoot } = input;
      const purpose = startInput.purpose ?? "conversation";
      const owner =
        startInput.owner ??
        (purpose === "transcription"
          ? ({
              kind: "transcription-test",
              requestId: VoiceTranscriptionRequestId.make(startInput.clientSessionId),
              providerAnchorThreadId: binding.controllerThreadId,
            } as const)
          : ({ kind: "controller", controllerThreadId: binding.controllerThreadId } as const));
      const existingOpen = yield* transports
        .getOpenByEnvironmentId(environmentId)
        .pipe(
          Effect.mapError(mapInternalError("internal_error", "The voice lease could not be read.")),
        );
      if (Option.isSome(existingOpen)) {
        const inMemory = Array.from((yield* Ref.get(sessionsRef)).values()).find(
          (session) => session.transportSessionId === existingOpen.value.transportSessionId,
        );
        if (
          inMemory !== undefined &&
          inMemory.fence.clientSessionId === startInput.clientSessionId &&
          inMemory.fence.generation === startInput.generation &&
          inMemory.fence.owner !== undefined &&
          voiceSessionOwnersEqual(inMemory.fence.owner, owner)
        ) {
          yield* input.onActivated(inMemory);
          return {
            environmentId,
            owner,
            controller: inMemory.controller,
            transportThreadId: inMemory.fence.transportThreadId,
            clientSessionId: inMemory.fence.clientSessionId,
            generation: inMemory.fence.generation,
            runtimeInstanceId: inMemory.fence.runtimeInstanceId,
            realtimeSessionId: inMemory.fence.realtimeSessionId,
            answerSdp: inMemory.answerSdp,
            transportType: inMemory.transportType,
            ...(inMemory.transportType === "websocket"
              ? {
                  inputAudio: {
                    format: "pcm16" as const,
                    sampleRateHz: VOICE_PCM_DEFAULT_SAMPLE_RATE_HZ,
                    channels: VOICE_PCM_DEFAULT_CHANNELS,
                  },
                }
              : {}),
            eventCursor: VoiceEventSequence.make(inMemory.eventCursor),
          };
        }
        if (
          purpose === "transcription" &&
          (inMemory === undefined || inMemory.purpose === "transcription")
        ) {
          // A browser reload can strand the previous lab transport while the
          // provider still considers its lease active. An explicit
          // transcription test replaces that stale transcription transport so the
          // button remains repeatable across reloads and HMR.
          if (inMemory !== undefined) {
            yield* stopSession(inMemory);
          } else {
            yield* cleanupDurableTransportLease(existingOpen.value);
          }
        } else {
          return yield* voiceError(
            "generation_conflict",
            "This controller already has an active voice transport.",
            false,
          );
        }
      }
      const startTransportKind = resolveVoiceSessionStartTransport(startInput);
      // A browser client session may start multiple fenced generations over its
      // lifetime. The durable lease identity therefore includes the generation.
      const transportSessionId = `${startInput.clientSessionId}:${startInput.generation}`;
      const transportThreadId = ThreadId.make(
        `voice-transport:${binding.controllerThreadId}:${startInput.clientSessionId}:${startInput.generation}`,
      );
      const runtimeInstanceId = VoiceRuntimeInstanceId.make(yield* randomUuid);
      const realtimeSessionId = VoiceRealtimeSessionId.make(yield* randomUuid);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(
            `voice-transport:create:${transportSessionId}:${startInput.generation}`,
          ),
          threadId: transportThreadId,
          projectId: binding.hostProjectId,
          purpose: "voice-transport",
          title: "Voice transport",
          modelSelection: confirmedControllerModelSelection(controllerRuntime),
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        })
        .pipe(
          Effect.mapError(
            mapInternalError("internal_error", "The voice transport could not be provisioned."),
          ),
        );
      const opened = yield* transports
        .openOrReplay({
          transportSessionId,
          environmentId,
          owner,
          controllerThreadId: binding.controllerThreadId,
          transportThreadId,
          runtimeInstanceId,
          generation: startInput.generation,
          createdAt: now,
        })
        .pipe(
          Effect.mapError(
            mapInternalError("internal_error", "The voice transport lease could not be reserved."),
          ),
        );
      if (opened._tag === "conflict") {
        return yield* voiceError(
          "generation_conflict",
          "The voice transport generation conflicts with an existing lease.",
          false,
        );
      }
      const negotiated = yield* Effect.gen(function* () {
        const negotiated = yield* runtime
          .startTransport({
            transportThreadId,
            providerInstanceId: binding.providerInstanceId,
            cwd: workspaceRoot,
            modelSelection: confirmedControllerModelSelection(controllerRuntime),
            runtimeMode: "approval-required",
            runtimeInstanceId,
            generation: startInput.generation,
            realtimeSessionId,
            transportType: startTransportKind.type,
            ...(startTransportKind.type === "webrtc"
              ? { offerSdp: startTransportKind.offerSdp }
              : {}),
            ...(startInput.voiceId !== undefined ? { voiceId: startInput.voiceId } : {}),
            clientManagedHandoffs: true,
          })
          .pipe(
            Effect.mapError(
              mapInternalError(
                "negotiation_failed",
                startTransportKind.type === "websocket"
                  ? "The websocket voice session could not be started."
                  : "The WebRTC voice session could not be started.",
              ),
            ),
          );
        if (negotiated.runtimeInstanceId !== runtimeInstanceId) {
          return yield* voiceError(
            "protocol_violation",
            "The voice runtime identity changed during negotiation.",
            false,
          );
        }
        const activated = yield* transports
          .activate({
            transportSessionId,
            generation: startInput.generation,
            runtimeInstanceId,
            realtimeSessionId,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(
            Effect.mapError(
              mapInternalError(
                "internal_error",
                "The voice transport lease could not be activated.",
              ),
            ),
          );
        if (!activated) {
          return yield* voiceError(
            "stale_generation",
            "The voice transport generation was fenced during negotiation.",
            true,
          );
        }
        return negotiated;
      }).pipe(Effect.onError(() => cleanupDurableTransportLease(opened.session)));
      const fence: VoiceSessionFence = {
        environmentId,
        owner,
        controllerThreadId: binding.controllerThreadId,
        transportThreadId,
        clientSessionId: startInput.clientSessionId,
        generation: startInput.generation,
        runtimeInstanceId,
        realtimeSessionId,
      };
      const active: ActiveVoiceSession = {
        transportSessionId,
        fence,
        environmentId,
        hostProjectId: binding.hostProjectId,
        transportProviderInstanceId: binding.providerInstanceId,
        controller: controllerIdentity(binding),
        controllerRuntime,
        transportType: negotiated.transportType,
        purpose,
        answerSdp: negotiated.answerSdp,
        lastAudioSequence: 0,
        eventCursor: 0,
        history: [],
      };
      yield* Ref.update(sessionsRef, (sessions) => {
        const next = new Map(sessions);
        next.set(startInput.clientSessionId, active);
        return next;
      });
      const publicSessionId = publicVoiceSessionId(active);
      yield* emit(publicSessionId, { type: "session.state", state: "listening" });
      yield* input.onActivated(active);
      const current = (yield* Ref.get(sessionsRef)).get(publicSessionId) ?? active;
      return {
        environmentId,
        owner,
        controller: current.controller,
        transportThreadId,
        clientSessionId: startInput.clientSessionId,
        generation: startInput.generation,
        runtimeInstanceId,
        realtimeSessionId,
        answerSdp: negotiated.answerSdp,
        transportType: negotiated.transportType,
        ...(negotiated.transportType === "websocket"
          ? {
              inputAudio: {
                format: "pcm16" as const,
                sampleRateHz: VOICE_PCM_DEFAULT_SAMPLE_RATE_HZ,
                channels: VOICE_PCM_DEFAULT_CHANNELS,
              },
            }
          : {}),
        eventCursor: VoiceEventSequence.make(current.eventCursor),
      };
    });

    const startThreadCallTransport: VoiceTransportCoordinatorShape["startThreadCallTransport"] =
      Effect.fn("VoiceTransportCoordinator.startThreadCallTransport")(function* (input) {
        const {
          start: startInput,
          environmentId,
          thread,
          transportModelSelection,
          workspaceRoot,
        } = input;
        const owner = startInput.owner;
        const existingOpen = yield* transports
          .getOpenByEnvironmentId(environmentId)
          .pipe(
            Effect.mapError(
              mapInternalError("internal_error", "The voice lease could not be read."),
            ),
          );
        if (Option.isSome(existingOpen)) {
          const inMemory = Array.from((yield* Ref.get(sessionsRef)).values()).find(
            (session) => session.transportSessionId === existingOpen.value.transportSessionId,
          );
          if (
            inMemory !== undefined &&
            inMemory.fence.clientSessionId === startInput.clientSessionId &&
            inMemory.fence.generation === startInput.generation &&
            inMemory.fence.owner !== undefined &&
            voiceSessionOwnersEqual(inMemory.fence.owner, owner)
          ) {
            return {
              environmentId,
              owner,
              controller: null,
              transportThreadId: inMemory.fence.transportThreadId,
              clientSessionId: inMemory.fence.clientSessionId,
              generation: inMemory.fence.generation,
              runtimeInstanceId: inMemory.fence.runtimeInstanceId,
              realtimeSessionId: inMemory.fence.realtimeSessionId,
              answerSdp: inMemory.answerSdp,
              transportType: inMemory.transportType,
              ...(inMemory.transportType === "websocket"
                ? {
                    inputAudio: {
                      format: "pcm16" as const,
                      sampleRateHz: VOICE_PCM_DEFAULT_SAMPLE_RATE_HZ,
                      channels: VOICE_PCM_DEFAULT_CHANNELS,
                    },
                  }
                : {}),
              eventCursor: VoiceEventSequence.make(inMemory.eventCursor),
            };
          }
          return yield* voiceError(
            "generation_conflict",
            "This environment already has an active voice session.",
            false,
          );
        }

        const startTransportKind = resolveVoiceSessionStartTransport(startInput);
        const transportSessionId = `${startInput.clientSessionId}:${startInput.generation}`;
        const transportThreadId = ThreadId.make(
          `voice-transport:${thread.id}:${startInput.clientSessionId}:${startInput.generation}`,
        );
        const runtimeInstanceId = VoiceRuntimeInstanceId.make(yield* randomUuid);
        const realtimeSessionId = VoiceRealtimeSessionId.make(yield* randomUuid);
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make(
              `voice-transport:create:${transportSessionId}:${startInput.generation}`,
            ),
            threadId: transportThreadId,
            projectId: thread.projectId,
            purpose: "voice-transport",
            title: "Voice transport",
            modelSelection: transportModelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          })
          .pipe(
            Effect.mapError(
              mapInternalError("internal_error", "The voice transport could not be provisioned."),
            ),
          );
        const opened = yield* transports
          .openOrReplay({
            transportSessionId,
            environmentId,
            owner,
            controllerThreadId: thread.id,
            transportThreadId,
            runtimeInstanceId,
            generation: startInput.generation,
            createdAt: now,
          })
          .pipe(
            Effect.mapError(
              mapInternalError(
                "internal_error",
                "The voice transport lease could not be reserved.",
              ),
            ),
          );
        if (opened._tag === "conflict") {
          return yield* voiceError(
            "generation_conflict",
            "The voice transport generation conflicts with an existing lease.",
            false,
          );
        }
        const negotiated = yield* Effect.gen(function* () {
          const negotiated = yield* runtime
            .startTransport({
              transportThreadId,
              providerInstanceId: transportModelSelection.instanceId,
              cwd: workspaceRoot,
              modelSelection: transportModelSelection,
              runtimeMode: "approval-required",
              runtimeInstanceId,
              generation: startInput.generation,
              realtimeSessionId,
              transportType: startTransportKind.type,
              ...(startTransportKind.type === "webrtc"
                ? { offerSdp: startTransportKind.offerSdp }
                : {}),
              ...(startInput.voiceId !== undefined ? { voiceId: startInput.voiceId } : {}),
              clientManagedHandoffs: true,
              prompt: CALL_REALTIME_PROMPT,
              includeStartupContext: false,
              initialItems: boundedCallInitialItems(thread.messages),
            })
            .pipe(
              Effect.mapError(
                mapInternalError(
                  "negotiation_failed",
                  "The direct voice call could not be started.",
                ),
              ),
            );
          if (negotiated.runtimeInstanceId !== runtimeInstanceId) {
            return yield* voiceError(
              "protocol_violation",
              "The voice runtime identity changed during negotiation.",
              false,
            );
          }
          const activated = yield* transports
            .activate({
              transportSessionId,
              generation: startInput.generation,
              runtimeInstanceId,
              realtimeSessionId,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(
              Effect.mapError(
                mapInternalError(
                  "internal_error",
                  "The voice transport lease could not be activated.",
                ),
              ),
            );
          if (!activated) {
            return yield* voiceError(
              "stale_generation",
              "The voice transport generation was fenced during negotiation.",
              true,
            );
          }
          return negotiated;
        }).pipe(Effect.onError(() => cleanupDurableTransportLease(opened.session)));
        const fence: VoiceSessionFence = {
          environmentId,
          owner,
          controllerThreadId: thread.id,
          transportThreadId,
          clientSessionId: startInput.clientSessionId,
          generation: startInput.generation,
          runtimeInstanceId,
          realtimeSessionId,
        };
        const active: ActiveVoiceSession = {
          transportSessionId,
          fence,
          environmentId,
          hostProjectId: thread.projectId,
          transportProviderInstanceId: transportModelSelection.instanceId,
          controller: null,
          controllerRuntime: null,
          transportType: negotiated.transportType,
          purpose: "conversation",
          answerSdp: negotiated.answerSdp,
          lastAudioSequence: 0,
          eventCursor: 0,
          history: [],
        };
        yield* Ref.update(sessionsRef, (sessions) => {
          const next = new Map(sessions);
          next.set(startInput.clientSessionId, active);
          return next;
        });
        yield* emit(startInput.clientSessionId, { type: "session.state", state: "listening" });
        const current = (yield* Ref.get(sessionsRef)).get(startInput.clientSessionId) ?? active;
        return {
          environmentId,
          owner,
          controller: null,
          transportThreadId,
          clientSessionId: startInput.clientSessionId,
          generation: startInput.generation,
          runtimeInstanceId,
          realtimeSessionId,
          answerSdp: negotiated.answerSdp,
          transportType: negotiated.transportType,
          ...(negotiated.transportType === "websocket"
            ? {
                inputAudio: {
                  format: "pcm16" as const,
                  sampleRateHz: VOICE_PCM_DEFAULT_SAMPLE_RATE_HZ,
                  channels: VOICE_PCM_DEFAULT_CHANNELS,
                },
              }
            : {}),
          eventCursor: VoiceEventSequence.make(current.eventCursor),
        };
      });

    const stop: VoiceTransportCoordinatorShape["stop"] = Effect.fn(
      "VoiceTransportCoordinator.stop",
    )(function* (input) {
      const session = (yield* Ref.get(sessionsRef)).get(input.clientSessionId);
      if (session === undefined) return { stopped: false };
      if (!fenceMatches(session, input)) {
        return yield* voiceError(
          "stale_generation",
          "The stop request is for an obsolete voice generation.",
          false,
        );
      }
      yield* stopSession(session);
      return { stopped: true };
    });

    const subscribe: VoiceTransportCoordinatorShape["subscribe"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const snapshot = yield* eventMutex.withPermits(1)(
            Effect.gen(function* () {
              const session = (yield* Ref.get(sessionsRef)).get(input.clientSessionId);
              const subscription = yield* PubSub.subscribe(events);
              return { session, subscription };
            }),
          );
          const session = snapshot.session;
          if (
            session === undefined ||
            (input.environmentId !== undefined && input.environmentId !== session.environmentId) ||
            (input.owner !== undefined &&
              (session.fence.owner === undefined ||
                !voiceSessionOwnersEqual(input.owner, session.fence.owner))) ||
            session.fence.generation !== input.generation ||
            session.fence.runtimeInstanceId !== input.runtimeInstanceId
          ) {
            return Stream.fail(
              voiceError("session_not_found", "The voice session is not active.", false),
            );
          }
          const after = input.afterSequence ?? VoiceEventSequence.make(0);
          const replay = session.history.filter((event) => event.sequence > after);
          // Events through the snapshot cursor are already represented by
          // replay. The subscription was installed under the emitter mutex, so
          // every later event is guaranteed to appear in this live stream.
          const live = Stream.fromSubscription(snapshot.subscription).pipe(
            Stream.filter(
              (event) =>
                event.clientSessionId === input.clientSessionId &&
                event.generation === input.generation &&
                event.runtimeInstanceId === input.runtimeInstanceId &&
                event.sequence > session.eventCursor,
            ),
          );
          return Stream.concat(Stream.fromIterable(replay), live);
        }),
      );

    return VoiceTransportCoordinator.of({
      getSession: (clientSessionId) =>
        Ref.get(sessionsRef).pipe(Effect.map((sessions) => sessions.get(clientSessionId))),
      getSessions: () => Ref.get(sessionsRef),
      findSessionByTransport: (match) =>
        Ref.get(sessionsRef).pipe(
          Effect.map((sessions) =>
            Array.from(sessions.values()).find(
              (candidate) =>
                candidate.fence.transportThreadId === match.transportThreadId &&
                candidate.fence.runtimeInstanceId === match.runtimeInstanceId &&
                candidate.fence.generation === match.generation &&
                candidate.fence.realtimeSessionId === match.realtimeSessionId,
            ),
          ),
        ),
      findSessionsByControllerRuntime: (match) =>
        Ref.get(sessionsRef).pipe(
          Effect.map((sessions) =>
            Array.from(sessions.values()).filter(
              (session) =>
                session.fence.controllerThreadId === match.controllerThreadId &&
                session.controllerRuntime !== null &&
                session.controllerRuntime.runtimeInstanceId === match.controllerRuntimeInstanceId,
            ),
          ),
        ),
      emit,
      stopSession,
      stopAll: () =>
        Effect.gen(function* () {
          const sessions = yield* Ref.get(sessionsRef);
          yield* Effect.forEach(sessions.values(), stopSession, { discard: true });
        }),
      stopForController: (controllerThreadId) =>
        Effect.gen(function* () {
          const sessions = yield* Ref.get(sessionsRef);
          yield* Effect.forEach(
            Array.from(sessions.values()).filter(
              (session) => session.fence.controllerThreadId === controllerThreadId,
            ),
            stopSession,
            { discard: true },
          );
        }),
      cleanupStaleStartupLease,
      startTransport,
      startThreadCallTransport,
      stop,
      subscribe,
      putControllerRuntime: (controllerThreadId, runtimeState) =>
        Ref.update(controllerRuntimesRef, (runtimes) => {
          const next = new Map(runtimes);
          next.set(controllerThreadId, runtimeState);
          return next;
        }),
      getControllerRuntime: (controllerThreadId) =>
        Ref.get(controllerRuntimesRef).pipe(
          Effect.map((runtimes) => runtimes.get(controllerThreadId)),
        ),
      deleteControllerRuntime: (controllerThreadId) =>
        Ref.update(controllerRuntimesRef, (runtimes) => {
          const next = new Map(runtimes);
          next.delete(controllerThreadId);
          return next;
        }),
      fenceMatches,
      appendAudio: Effect.fn("VoiceTransportCoordinator.appendAudio")(function* (input) {
        const session = (yield* Ref.get(sessionsRef)).get(input.clientSessionId);
        if (session === undefined) {
          return { accepted: false, code: "session_not_found" as const };
        }
        if (!fenceMatches(session, input)) {
          return { accepted: false, code: "stale_generation" as const };
        }
        if (session.transportType !== "websocket") {
          return { accepted: false, code: "unsupported_transport" as const };
        }
        if (input.sequence <= session.lastAudioSequence) {
          return { accepted: false, code: "out_of_order" as const };
        }
        // Single-slot backpressure: reject when the previous chunk is still in flight
        // by treating a large sequence gap as overload after a bounded queue of 8.
        if (input.sequence > session.lastAudioSequence + 8) {
          return { accepted: false, code: "overload" as const };
        }
        yield* Ref.update(sessionsRef, (sessions) => {
          const current = sessions.get(input.clientSessionId);
          if (current === undefined) return sessions;
          const next = new Map(sessions);
          next.set(input.clientSessionId, { ...current, lastAudioSequence: input.sequence });
          return next;
        });
        yield* runtime
          .appendTransportAudio({
            transportThreadId: session.fence.transportThreadId,
            generation: session.fence.generation,
            audioBase64: input.audioBase64,
          })
          .pipe(Effect.ignore);
        return { accepted: true };
      }),
      deliverAssistantUpdate: Effect.fn("VoiceTransportCoordinator.deliverAssistantUpdate")(
        function* (input) {
          const { session } = input;
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          const optionalIdentity = {
            ...(input.voiceActionId !== undefined ? { voiceActionId: input.voiceActionId } : {}),
            ...(input.targetThreadId !== undefined ? { targetThreadId: input.targetThreadId } : {}),
            ...(input.phase !== undefined ? { phase: input.phase } : {}),
          };
          const decision = yield* Ref.modify(speechMemoryRef, (memory) => {
            const result = decideProactiveSpeech({
              kind: input.kind,
              text: input.text,
              transportSessionId: session.transportSessionId,
              generation: session.fence.generation,
              nowMs,
              memory,
              expectedGeneration: session.fence.generation,
              ...optionalIdentity,
            });
            if (result.speak) {
              const next = new Map(memory);
              rememberProactiveSpeech(next, {
                kind: input.kind,
                text: result.text,
                transportSessionId: session.transportSessionId,
                generation: session.fence.generation,
                nowMs,
                ...optionalIdentity,
              });
              return [result, next] as const;
            }
            return [result, memory] as const;
          });
          const trayText =
            decision.text.length > 0 ? decision.text : input.text.trim().slice(0, 512);
          if (trayText.length > 0) {
            yield* runVoiceTransportFeedback(
              runtime.appendTransportText({
                transportThreadId: session.fence.transportThreadId,
                generation: session.fence.generation,
                text: trayText,
              }),
            );
          }
          if (decision.speak) {
            yield* speechArbiter.enqueue({
              attemptId: yield* randomUuid,
              source: "controller",
              session,
              threadId: session.fence.controllerThreadId,
              turnId: null,
              requestedText: decision.text,
              requestedAt: DateTime.formatIso(yield* DateTime.now),
            });
          }
        },
      ),
    });
  },
);

export const VoiceTransportCoordinatorLive = Layer.effect(
  VoiceTransportCoordinator,
  makeVoiceTransportCoordinator(),
);
