import {
  CommandId,
  ThreadId,
  VOICE_PCM_DEFAULT_CHANNELS,
  VOICE_PCM_DEFAULT_SAMPLE_RATE_HZ,
  VoiceEventSequence,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
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
import { VoiceControllerBindingRepository } from "../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceTransportSessionRepository } from "../../persistence/Services/VoiceTransportSessions.ts";
import type { VoiceTransportSession } from "../../persistence/VoiceControlModels.ts";
import {
  VoiceTransportCoordinator,
  type ActiveVoiceSession,
  type ControllerRuntimeState,
  type VoiceTransportCoordinatorShape,
} from "../Services/VoiceTransportCoordinator.ts";
import { VoiceRuntimeGateway } from "../Services/VoiceRuntimeGateway.ts";
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
  voiceError,
} from "./voiceControllerShared.ts";

export const makeVoiceTransportCoordinator = Effect.fn("VoiceTransportCoordinator.make")(
  function* () {
    const crypto = yield* Crypto.Crypto;
    const environment = yield* ServerEnvironment;
    const engine = yield* OrchestrationEngineService;
    const bindings = yield* VoiceControllerBindingRepository;
    const transports = yield* VoiceTransportSessionRepository;
    const actions = yield* VoiceControllerActionRepository;
    const runtime = yield* VoiceRuntimeGateway;
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
          controllerThreadId: session.controllerThreadId,
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
      Effect.fn("VoiceTransportCoordinator.cleanupStaleStartupLease")(
        function* (controllerThreadId) {
          const staleStartupLease = yield* transports
            .getOpenByControllerThreadId(controllerThreadId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(staleStartupLease)) {
            yield* cleanupDurableTransportLease(staleStartupLease.value);
          }
        },
      );

    const startupEnvironmentId = yield* environment.getEnvironmentId;
    const startupBinding = yield* bindings
      .getByEnvironmentId(startupEnvironmentId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(startupBinding)) {
      yield* cleanupStaleStartupLease(startupBinding.value.controllerThreadId);
    }

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
      const existingOpen = yield* transports
        .getOpenByControllerThreadId(startInput.controllerThreadId)
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
          inMemory.fence.generation === startInput.generation
        ) {
          yield* input.onActivated(inMemory);
          return {
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
        providerInstanceId: binding.providerInstanceId,
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
            yield* runVoiceTransportFeedback(
              runtime.appendTransportSpeech({
                transportThreadId: session.fence.transportThreadId,
                generation: session.fence.generation,
                text: decision.text,
              }),
            );
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
